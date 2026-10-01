import os
import asyncio
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .llm import answer_memory_question, generate_with_fast_model
from .memory import get_memory_store
from .models import ChatRequest, ProcessResult, QuickNoteRequest
from .transcription import transcribe_audio

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
ALLOWED_EXTENSIONS = {".qta", ".m4a", ".wav", ".mp3", ".mp4", ".webm", ".ogg"}

app = FastAPI(title="Voice Notes AI")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")
jobs: dict[str, dict[str, Any]] = {}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="dashboard.html", context={})


def _process(path: Path, job_id: str, source_name: str) -> ProcessResult:
    jobs[job_id]["status"] = "transcribing"
    jobs[job_id]["message"] = "Transcribing audio with Whisper"
    transcript, language = transcribe_audio(
        str(path),
        progress=lambda message: jobs[job_id].update(status="transcribing", message=message),
    )
    if not transcript:
        raise RuntimeError("No speech was detected in the recording.")
    jobs[job_id]["status"] = "generating_summary"
    jobs[job_id]["message"] = "Generating notes with Ollama"
    notes = generate_with_fast_model(transcript)
    result = ProcessResult(
        language=language,
        transcript=transcript,
        notes=notes,
        source_name=source_name,
    )
    jobs[job_id]["status"] = "saving_memory"
    jobs[job_id]["message"] = "Indexing this note in your second brain"
    get_memory_store().save(result, source_name)
    return result


async def _run_job(job_id: str, path: Path, source_name: str):
    try:
        result = await run_in_threadpool(_process, path, job_id, source_name)
        jobs[job_id].update(status="complete", message="Complete", result=result.model_dump())
    except Exception as exc:
        detail = str(exc)
        if "not found" in detail.lower() and "ollama" in detail.lower():
            detail += " Start Ollama and install the configured model, for example: ollama pull gemma3:4b"
        jobs[job_id].update(status="error", message=detail)
    finally:
        if not os.getenv("KEEP_UPLOADS", "false").lower() == "true":
            path.unlink(missing_ok=True)


@app.post("/api/process")
async def process_audio(file: UploadFile = File(...)):
    source_name = Path(file.filename or "recording").name
    extension = Path(source_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Supported formats: .qta, .m4a, .wav, .mp3, .mp4, .webm, and .ogg",
        )

    job_id = str(uuid.uuid4())
    path = UPLOAD_DIR / f"{job_id}{extension}"
    jobs[job_id] = {"status": "uploading", "message": "Uploading audio"}
    try:
        total = 0
        with path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="The maximum upload size is 500 MB.")
                output.write(chunk)
        jobs[job_id].update(status="uploaded", message="Uploaded — ready to transcribe")
        asyncio.create_task(_run_job(job_id, path, source_name))
        return {"job_id": job_id, "status": "uploaded", "message": "Uploaded — ready to transcribe"}
    except HTTPException:
        raise
    except Exception as exc:
        detail = str(exc)
        raise HTTPException(status_code=500, detail=detail) from exc
    finally:
        await file.close()


@app.get("/api/status/{job_id}")
async def process_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Processing job not found.")
    return job


@app.get("/api/memories")
async def list_memories(limit: int = 50):
    return {"memories": await run_in_threadpool(get_memory_store().list_memories, limit)}


@app.get("/api/memories/{memory_id}")
async def get_memory(memory_id: str):
    memory = await run_in_threadpool(get_memory_store().get, memory_id)
    if not memory:
        raise HTTPException(status_code=404, detail="Memory not found.")
    return memory


@app.get("/api/graph")
async def get_graph():
    return await run_in_threadpool(get_memory_store().graph)


def _answer_chat(request: ChatRequest) -> dict[str, Any]:
    contexts = get_memory_store().search(request.question)
    answer = answer_memory_question(
        request.question,
        contexts,
        history=request.history,
        use_smart_model=request.use_smart_model,
    )
    sources = []
    seen = set()
    for item in contexts:
        memory_id = item.get("memory_id")
        key = (memory_id, item.get("source"))
        if key in seen or not memory_id:
            continue
        seen.add(key)
        sources.append({
            "memory_id": memory_id,
            "title": item.get("source", "Saved memory"),
            "created_at": item.get("created_at", ""),
        })
    return {"answer": answer, "sources": sources}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    try:
        return await run_in_threadpool(_answer_chat, request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _save_quick_note(request: QuickNoteRequest) -> ProcessResult:
    notes = generate_with_fast_model(request.content)
    if request.title.strip():
        notes.title = request.title.strip()
    result = ProcessResult(
        language="text",
        transcript=request.content,
        notes=notes,
        source_name="Quick note",
    )
    get_memory_store().save(result, "Quick note")
    return result


@app.post("/api/notes", response_model=ProcessResult)
async def create_quick_note(request: QuickNoteRequest):
    try:
        return await run_in_threadpool(_save_quick_note, request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
