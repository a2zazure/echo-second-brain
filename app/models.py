from pydantic import BaseModel, Field


class ActionItem(BaseModel):
    action: str
    owner: str = "Not specified"
    deadline: str = "Not specified"


class Entity(BaseModel):
    name: str
    type: str = "concept"


class Relationship(BaseModel):
    source: str
    relation: str
    target: str


class Notes(BaseModel):
    title: str
    summary: str
    key_points: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    entities: list[Entity] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)


class ProcessResult(BaseModel):
    language: str
    transcript: str
    notes: Notes
    memory_id: str | None = None
    source_name: str | None = None
    created_at: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list)
    use_smart_model: bool = False


class QuickNoteRequest(BaseModel):
    title: str = Field(default="", max_length=200)
    content: str = Field(min_length=1, max_length=100000)
