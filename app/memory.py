import json
import re
import threading
import uuid
import hashlib
import numpy as np
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings

from .models import ProcessResult


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MEMORIES_DIR = DATA_DIR / "memories"
CHROMA_DIR = DATA_DIR / "chroma"
GRAPH_FILE = DATA_DIR / "memory_graph.json"


def _chunks(text: str, size: int = 260, overlap: int = 45) -> list[str]:
    words = text.split()
    if not words:
        return []
    output = []
    step = max(1, size - overlap)
    for start in range(0, len(words), step):
        chunk = " ".join(words[start : start + size]).strip()
        if chunk:
            output.append(chunk)
        if start + size >= len(words):
            break
    return output


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-") or "unknown"


def semantic_edges(ids, embeddings, threshold=0.60, neighbors=3):
    """Bounded undirected cosine neighbors; similarity is not a factual relation."""
    matrix = np.asarray(embeddings, dtype=float)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix = matrix / np.maximum(norms, 1e-12)
    similarities = matrix @ matrix.T
    candidates = sorted(((float(similarities[i, j]), i, j)
                         for i in range(len(ids)) for j in range(i + 1, len(ids))
                         if similarities[i, j] >= threshold), reverse=True)
    degree = [0] * len(ids)
    edges = []
    for score, i, j in candidates:
        if degree[i] >= neighbors or degree[j] >= neighbors:
            continue
        degree[i] += 1
        degree[j] += 1
        edges.append({'id': f'semantic:{ids[i]}:{ids[j]}', 'source': ids[i], 'target': ids[j],
                      'kind': 'semantic', 'relation': 'similar meaning', 'similarity': round(score, 4)})
    return edges


class MemoryStore:
    def __init__(self) -> None:
        MEMORIES_DIR.mkdir(parents=True, exist_ok=True)
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._client = chromadb.PersistentClient(
            path=str(CHROMA_DIR),
            settings=Settings(anonymized_telemetry=False),
        )
        self._collection = self._client.get_or_create_collection(
            name="voice_note_memories",
            metadata={"hnsw:space": "cosine"},
        )

    def save(self, result: ProcessResult, source_name: str) -> dict[str, str]:
        memory_id = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        result.memory_id = memory_id
        result.source_name = source_name
        result.created_at = created_at
        payload = result.model_dump()
        payload["memory_id"] = memory_id

        notes = result.notes
        note_text = "\n".join([
            f"Title: {notes.title}",
            f"Summary: {notes.summary}",
            "Key points: " + "; ".join(notes.key_points),
            "Decisions: " + ("; ".join(notes.decisions) or "None"),
            "Action items: " + ("; ".join(
                f"{item.action} — owner {item.owner}, deadline {item.deadline}"
                for item in notes.action_items
            ) or "None"),
            "Tags: " + ", ".join(notes.tags),
        ])
        transcript_chunks = _chunks(result.transcript)
        documents = [note_text] + transcript_chunks
        ids = [f"{memory_id}:notes"] + [f"{memory_id}:transcript:{index}" for index in range(len(transcript_chunks))]
        metadatas = [{
            "memory_id": memory_id,
            "source": notes.title or source_name,
            "source_name": source_name,
            "created_at": created_at,
            "kind": "notes" if index == 0 else "transcript",
            "chunk": index,
        } for index in range(len(documents))]

        with self._lock:
            (MEMORIES_DIR / f"{memory_id}.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._collection.add(ids=ids, documents=documents, metadatas=metadatas)
            self._update_graph(payload)
        return {"memory_id": memory_id, "created_at": created_at}

    def list_memories(self, limit: int = 50) -> list[dict[str, Any]]:
        memories = []
        for path in MEMORIES_DIR.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                notes = data.get("notes", {})
                memories.append({
                    "memory_id": data.get("memory_id", path.stem),
                    "title": notes.get("title") or data.get("source_name") or "Untitled voice note",
                    "summary": notes.get("summary", ""),
                    "tags": notes.get("tags", []),
                    "source_name": data.get("source_name", "Recording"),
                    "language": data.get("language", "unknown"),
                    "created_at": data.get("created_at", ""),
                })
            except (OSError, json.JSONDecodeError):
                continue
        memories.sort(key=lambda item: item["created_at"], reverse=True)
        return memories[: max(1, min(limit, 200))]

    def get(self, memory_id: str) -> dict[str, Any] | None:
        path = MEMORIES_DIR / f"{memory_id}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def search(self, question: str, limit: int = 7) -> list[dict[str, Any]]:
        if self._collection.count() == 0:
            return []
        result = self._collection.query(query_texts=[question], n_results=min(limit, self._collection.count()))
        documents = (result.get("documents") or [[]])[0]
        metadatas = (result.get("metadatas") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
        contexts = []
        seen = set()
        for document, metadata, distance in zip(documents, metadatas, distances):
            marker = (metadata.get("memory_id"), document)
            if marker in seen:
                continue
            seen.add(marker)
            contexts.append({
                "text": document,
                "source": metadata.get("source") or metadata.get("source_name") or "Saved memory",
                "memory_id": metadata.get("memory_id"),
                "created_at": metadata.get("created_at", ""),
                "distance": distance,
            })
        graph_context = self._graph_context(question)
        if graph_context:
            contexts.append({"text": graph_context, "source": "Knowledge graph", "created_at": ""})
        return contexts

    def graph(self) -> dict[str, Any]:
        with self._lock:
            graph = self._load_graph()
            nodes = sorted(graph["nodes"].values(), key=lambda item: item.get("count", 0), reverse=True)[:80]
            ids = {n['id'] for n in nodes}
            edges = [dict(e, kind='explicit') for e in graph['edges'].values()
                     if e['source'] in ids and e['target'] in ids]
            entities = [n for n in nodes if n['type'] != 'memory']
            collection = self._client.get_or_create_collection(name='topic_semantics_v1', metadata={'hnsw:space': 'cosine'})
            cached = collection.get(include=['metadatas'])
            fingerprints = dict(zip(cached['ids'], cached['metadatas']))
            documents, changed = [], []
            for node in entities:
                sources = [graph['nodes'][e['source']] for e in graph['edges'].values()
                           if e['target'] == node['id'] and e['relation'] == 'mentions']
                node['sources'] = [{'memory_id': s['memory_id'], 'title': s['label']} for s in sources]
                contexts = []
                for source in sources[:3]:
                    memory = self.get(source['memory_id']) or {}
                    summary = memory.get('notes', {}).get('summary', '')
                    contexts.append(summary[:450])
                document = f"{node['label']}. {node['label']}. " + ' '.join(contexts)
                fingerprint = hashlib.sha256(document.encode()).hexdigest()
                if (fingerprints.get(node['id']) or {}).get('fingerprint') != fingerprint:
                    changed.append((node['id'], fingerprint))
                    documents.append(document)
            if changed:
                collection.upsert(ids=[v[0] for v in changed], documents=documents,
                                  metadatas=[{'fingerprint': v[1]} for v in changed])
            if len(entities) > 1:
                vectors = collection.get(ids=[n['id'] for n in entities], include=['embeddings'])
                edges.extend(semantic_edges(vectors['ids'], vectors['embeddings']))
            return {'nodes': nodes, 'edges': edges, 'node_count': len(graph['nodes']),
                    'edge_count': len(edges), 'semantic_count': sum(e.get('kind') == 'semantic' for e in edges)}

    def _load_graph(self) -> dict[str, dict[str, Any]]:
        if GRAPH_FILE.exists():
            try:
                graph = json.loads(GRAPH_FILE.read_text(encoding="utf-8"))
                if isinstance(graph.get("nodes"), dict) and isinstance(graph.get("edges"), dict):
                    return graph
            except (OSError, json.JSONDecodeError):
                pass
        return {"nodes": {}, "edges": {}}

    def _update_graph(self, memory: dict[str, Any]) -> None:
        graph = self._load_graph()
        notes = memory.get("notes", {})
        memory_id = memory["memory_id"]
        memory_node = f"memory:{memory_id}"
        graph["nodes"][memory_node] = {
            "id": memory_node,
            "label": notes.get("title") or memory.get("source_name") or "Voice note",
            "type": "memory",
            "count": 1,
            "memory_id": memory_id,
        }
        entities = list(notes.get("entities") or [])
        for tag in notes.get("tags") or []:
            entities.append({"name": tag, "type": "topic"})
        for action in notes.get("action_items") or []:
            owner = action.get("owner")
            if owner and owner != "Not specified":
                entities.append({"name": owner, "type": "person"})

        for entity in entities:
            name = str(entity.get("name") or "").strip()
            if not name:
                continue
            node_id = f"entity:{_key(name)}"
            node = graph["nodes"].setdefault(node_id, {
                "id": node_id, "label": name, "type": entity.get("type") or "concept", "count": 0
            })
            node["count"] = int(node.get("count", 0)) + 1
            edge_id = f"{memory_node}|mentions|{node_id}"
            graph["edges"][edge_id] = {
                "id": edge_id, "source": memory_node, "relation": "mentions", "target": node_id, "count": 1
            }

        for relation in notes.get("relationships") or []:
            source_name = str(relation.get("source") or "").strip()
            target_name = str(relation.get("target") or "").strip()
            relation_name = str(relation.get("relation") or "related to").strip()
            if not source_name or not target_name:
                continue
            source_id, target_id = f"entity:{_key(source_name)}", f"entity:{_key(target_name)}"
            graph["nodes"].setdefault(source_id, {"id": source_id, "label": source_name, "type": "concept", "count": 1})
            graph["nodes"].setdefault(target_id, {"id": target_id, "label": target_name, "type": "concept", "count": 1})
            edge_id = f"{source_id}|{_key(relation_name)}|{target_id}"
            edge = graph["edges"].setdefault(edge_id, {
                "id": edge_id, "source": source_id, "relation": relation_name, "target": target_id, "count": 0
            })
            edge["count"] = int(edge.get("count", 0)) + 1
        GRAPH_FILE.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")

    def _graph_context(self, question: str) -> str:
        graph = self._load_graph()
        terms = {_key(word) for word in question.split() if len(word) > 2}
        matched_ids = {
            node_id for node_id, node in graph["nodes"].items()
            if _key(str(node.get("label", ""))) in terms or any(term in _key(str(node.get("label", ""))) for term in terms)
        }
        lines = []
        for edge in graph["edges"].values():
            if edge.get("source") in matched_ids or edge.get("target") in matched_ids:
                source = graph["nodes"].get(edge["source"], {}).get("label", edge["source"])
                target = graph["nodes"].get(edge["target"], {}).get("label", edge["target"])
                lines.append(f"{source} — {edge.get('relation', 'related to')} → {target}")
        return "Knowledge graph relationships:\n" + "\n".join(lines[:20]) if lines else ""


@lru_cache(maxsize=1)
def get_memory_store() -> MemoryStore:
    return MemoryStore()
