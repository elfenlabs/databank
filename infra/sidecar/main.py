"""Embedding Sidecar — stateless microservice that converts text to vectors."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("EMBED_MODEL", "BAAI/bge-small-en-v1.5")

model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    model = SentenceTransformer(MODEL_NAME)
    yield
    model = None


app = FastAPI(title="Embedding Sidecar", lifespan=lifespan)


class SingleRequest(BaseModel):
    text: str


class BatchRequest(BaseModel):
    texts: list[str]


class SingleResponse(BaseModel):
    vector: list[float]


class BatchResponse(BaseModel):
    vectors: list[list[float]]


@app.post("/embed", response_model=SingleResponse | BatchResponse)
async def embed(body: SingleRequest | BatchRequest):
    """Embed one or many texts. Matches the PRD contract."""
    if isinstance(body, SingleRequest):
        vector = model.encode(body.text).tolist()
        return SingleResponse(vector=vector)
    else:
        vectors = model.encode(body.texts).tolist()
        return BatchResponse(vectors=vectors)
