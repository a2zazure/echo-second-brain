import json
import os
from typing import Any

import ollama

from .models import ChatMessage, Entity, Notes, Relationship

SYSTEM_PROMPT = """You are an AI meeting and voice-note assistant.
Analyze the supplied transcript and return structured notes.
Identify a concise summary, important key points, explicit decisions, and action items.
Include owners and deadlines only when explicitly stated. Do not invent information.
If an owner or deadline is not present, use 'Not specified'.
Create a short descriptive title, 3-8 useful tags, important entities, and only relationships explicitly stated in the transcript.
If a relationship is uncertain or merely implied, do not include it.
Entity types may include person, organization, place, project, topic, or date.
Return valid JSON only with this shape:
{"title":"...","summary":"...","key_points":["..."],"decisions":["..."],"action_items":[{"action":"...","owner":"Not specified","deadline":"Not specified"}],"tags":["..."],"entities":[{"name":"...","type":"person"}],"relationships":[{"source":"...","relation":"...","target":"..."}]}"""

MEMORY_SYSTEM_PROMPT = """You are the user's private second-brain assistant.
Answer using only the supplied memory context. Synthesize across memories when useful.
If the context does not contain the answer, say that the saved memories do not contain enough information.
Do not invent facts. Mention source titles naturally so the user can trace the answer.
Be concise, helpful, and direct."""


def _model_name() -> str:
    return os.getenv("OLLAMA_FAST_MODEL") or os.getenv("OLLAMA_MODEL", "gemma3:4b")


def _parse_json(raw: str) -> dict[str, Any]:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```").removeprefix("json").removesuffix("```").strip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        # Some local models add a short sentence before the JSON object.
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        value = json.loads(cleaned[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("Ollama returned JSON, but not a JSON object.")
    return value


def _normalise_notes(data: dict[str, Any]) -> Notes:
    actions = data.get("action_items") or []
    if not isinstance(actions, list):
        actions = []
    clean_actions = []
    for item in actions:
        if isinstance(item, str):
            clean_actions.append({"action": item, "owner": "Not specified", "deadline": "Not specified"})
        elif isinstance(item, dict) and item.get("action"):
            clean_actions.append({
                "action": str(item["action"]),
                "owner": str(item.get("owner") or "Not specified"),
                "deadline": str(item.get("deadline") or "Not specified"),
            })
    entities = []
    for item in data.get("entities") or []:
        if isinstance(item, str):
            entities.append(Entity(name=item))
        elif isinstance(item, dict) and item.get("name"):
            entities.append(Entity(name=str(item["name"]), type=str(item.get("type") or "concept")))
    relationships = []
    for item in data.get("relationships") or []:
        if isinstance(item, dict) and item.get("source") and item.get("relation") and item.get("target"):
            relationships.append(Relationship(
                source=str(item["source"]),
                relation=str(item["relation"]),
                target=str(item["target"]),
            ))
    return Notes.model_validate({
        "title": str(data.get("title") or "Untitled voice note"),
        "summary": str(data.get("summary") or "No summary generated."),
        "key_points": [str(item) for item in (data.get("key_points") or [])],
        "decisions": [str(item) for item in (data.get("decisions") or [])],
        "action_items": clean_actions,
        "tags": [str(item) for item in (data.get("tags") or [])][:12],
        "entities": entities,
        "relationships": relationships,
    })


def generate_with_fast_model(transcript: str) -> Notes:
    client = ollama.Client(host=os.getenv("OLLAMA_HOST", "http://localhost:11434"))
    response = client.chat(
        model=_model_name(),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
        format=Notes.model_json_schema(),
        options={"temperature": 0},
    )
    try:
        return _normalise_notes(_parse_json(response["message"]["content"]))
    except (KeyError, json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError("Ollama returned invalid notes JSON. Try a model with good JSON support.") from exc


def generate_with_smart_model(transcript: str) -> Notes:
    model = os.getenv("OLLAMA_SMART_MODEL")
    if not model:
        raise RuntimeError("OLLAMA_SMART_MODEL is not configured.")
    previous = os.environ.get("OLLAMA_FAST_MODEL")
    os.environ["OLLAMA_FAST_MODEL"] = model
    try:
        return generate_with_fast_model(transcript)
    finally:
        if previous is None:
            os.environ.pop("OLLAMA_FAST_MODEL", None)
        else:
            os.environ["OLLAMA_FAST_MODEL"] = previous


def answer_memory_question(
    question: str,
    contexts: list[dict[str, Any]],
    history: list[ChatMessage] | None = None,
    use_smart_model: bool = False,
) -> str:
    model = _model_name()
    if use_smart_model:
        model = os.getenv("OLLAMA_SMART_MODEL") or model
    context_text = "\n\n".join(
        f"SOURCE: {item['source']} ({item.get('created_at', 'date unknown')})\n{item['text']}"
        for item in contexts
    ) or "No relevant saved memory was found."
    messages = [{"role": "system", "content": MEMORY_SYSTEM_PROMPT}]
    for message in (history or [])[-6:]:
        if message.role in {"user", "assistant"}:
            messages.append({"role": message.role, "content": message.content[:4000]})
    messages.append({
        "role": "user",
        "content": f"MEMORY CONTEXT\n{context_text}\n\nQUESTION\n{question}",
    })
    client = ollama.Client(host=os.getenv("OLLAMA_HOST", "http://localhost:11434"))
    response = client.chat(model=model, messages=messages, options={"temperature": 0.2})
    answer = response["message"]["content"].strip()
    if not answer:
        raise RuntimeError("Ollama returned an empty answer.")
    return answer
