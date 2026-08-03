"""Minimal dependency-free GLB reader/writer for the runtime refit lab.

The refit promotes hand-authored bodies into GLB shells that already carry the
exact runtime contract (50 joints in a fixed skin order, 47 authored clips).
Re-exporting those shells through Blender would renumber nodes, re-sort the skin
joint array and rewrite every animation sampler, so the promotion is done as
accessor-level surgery instead -- the same technique the 2026-07-21 runtime body
promotion used ("surgical accessor transplant, byte-preserving for
skeleton/animations/materials").

This module owns only the container: chunk parsing, typed accessor decode, and
a writer that rebuilds a single-buffer GLB from an edited JSON + a fresh binary
blob. Nothing here knows about humanoids.

Pure stdlib + numpy so it runs identically inside Blender's Python and out.
"""

from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

COMPONENT_DTYPE = {
    5120: np.int8,
    5121: np.uint8,
    5122: np.int16,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}
DTYPE_COMPONENT = {np.dtype(v): k for k, v in COMPONENT_DTYPE.items()}
TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4,
                   "MAT2": 4, "MAT3": 9, "MAT4": 16}
COMPONENTS_TYPE = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4"}

TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963


def _pad4(value: int) -> int:
    return (4 - (value % 4)) % 4


class Glb:
    """A parsed GLB: mutable `json`, immutable source `bin`."""

    def __init__(self, gltf: dict[str, Any], binary: bytes) -> None:
        self.json = gltf
        self.bin = binary

    # ---------------------------------------------------------------- read

    @classmethod
    def load(cls, path: str) -> "Glb":
        with open(path, "rb") as handle:
            raw = handle.read()
        magic, version, total = struct.unpack_from("<III", raw, 0)
        if magic != GLB_MAGIC:
            raise ValueError(f"{path}: not a GLB (magic {magic:#x})")
        if version != 2:
            raise ValueError(f"{path}: unsupported GLB version {version}")
        gltf: dict[str, Any] | None = None
        binary = b""
        offset = 12
        while offset < total:
            length, kind = struct.unpack_from("<II", raw, offset)
            payload = raw[offset + 8: offset + 8 + length]
            if kind == CHUNK_JSON:
                gltf = json.loads(payload.decode("utf-8"))
            elif kind == CHUNK_BIN:
                binary = bytes(payload)
            offset += 8 + length + _pad4(length)
        if gltf is None:
            raise ValueError(f"{path}: GLB has no JSON chunk")
        return cls(gltf, binary)

    def buffer_view_bytes(self, index: int) -> tuple[bytes, int | None]:
        view = self.json["bufferViews"][index]
        start = view.get("byteOffset", 0)
        return self.bin[start: start + view["byteLength"]], view.get("byteStride")

    def accessor(self, index: int) -> np.ndarray:
        """Decode accessor `index` into a (count, components) or (count,) array."""
        acc = self.json["accessors"][index]
        components = TYPE_COMPONENTS[acc["type"]]
        dtype = np.dtype(COMPONENT_DTYPE[acc["componentType"]])
        count = acc["count"]
        if "bufferView" not in acc:
            out = np.zeros((count, components), dtype=dtype)
        else:
            data, stride = self.buffer_view_bytes(acc["bufferView"])
            start = acc.get("byteOffset", 0)
            element = dtype.itemsize * components
            if stride and stride != element:
                out = np.empty((count, components), dtype=dtype)
                for row in range(count):
                    base = start + row * stride
                    out[row] = np.frombuffer(data[base: base + element], dtype=dtype)
            else:
                out = np.frombuffer(data[start: start + count * element],
                                    dtype=dtype).reshape(count, components).copy()
        return out.reshape(-1) if components == 1 else out


class GlbBuilder:
    """Accumulates buffer views for a rewritten single-buffer GLB."""

    def __init__(self, gltf: dict[str, Any]) -> None:
        self.json = gltf
        self.json["bufferViews"] = []
        self.json["accessors"] = []
        self.blob = bytearray()

    def add_view(self, payload: bytes, *, target: int | None = None,
                 stride: int | None = None) -> int:
        self.blob.extend(b"\x00" * _pad4(len(self.blob)))
        offset = len(self.blob)
        self.blob.extend(payload)
        view: dict[str, Any] = {"buffer": 0, "byteOffset": offset,
                                "byteLength": len(payload)}
        if target is not None:
            view["target"] = target
        if stride is not None:
            view["byteStride"] = stride
        self.json["bufferViews"].append(view)
        return len(self.json["bufferViews"]) - 1

    def add_accessor(self, array: np.ndarray, *, target: int | None = None,
                     normalized: bool = False, minmax: bool = False) -> int:
        data = np.ascontiguousarray(array)
        components = 1 if data.ndim == 1 else data.shape[1]
        view = self.add_view(data.tobytes(), target=target)
        acc: dict[str, Any] = {
            "bufferView": view,
            "componentType": DTYPE_COMPONENT[data.dtype],
            "count": int(data.shape[0]),
            "type": COMPONENTS_TYPE[components],
        }
        if normalized:
            acc["normalized"] = True
        if minmax:
            flat = data.reshape(data.shape[0], components)
            acc["min"] = [float(v) for v in flat.min(axis=0)]
            acc["max"] = [float(v) for v in flat.max(axis=0)]
        self.json["accessors"].append(acc)
        return len(self.json["accessors"]) - 1

    def write(self, path: str) -> int:
        self.json["buffers"] = [{"byteLength": len(self.blob)}]
        payload = json.dumps(self.json, separators=(",", ":"),
                             ensure_ascii=False, sort_keys=False).encode("utf-8")
        payload += b" " * _pad4(len(payload))
        blob = bytes(self.blob) + b"\x00" * _pad4(len(self.blob))
        total = 12 + 8 + len(payload) + 8 + len(blob)
        with open(path, "wb") as handle:
            handle.write(struct.pack("<III", GLB_MAGIC, 2, total))
            handle.write(struct.pack("<II", len(payload), CHUNK_JSON))
            handle.write(payload)
            handle.write(struct.pack("<II", len(blob), CHUNK_BIN))
            handle.write(blob)
        return total
