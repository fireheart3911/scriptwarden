import { useState } from "react";
import type { Character } from "../types";
import { api } from "../api";
import { ColorPicker } from "./ColorPicker";
import { colorForIndex } from "../lib/colors";

interface Props {
  productionId: number;
  characters: Character[];
  reload: () => void;
}

// Speaker roster with editable colors. Recoloring a character recolors every
// line they speak (colors resolve from here unless a line overrides).
export function CharactersPanel({ productionId, characters, reload }: Props) {
  const [newName, setNewName] = useState("");

  async function add() {
    const name = newName.trim();
    if (!name) return;
    await api.addCharacter(productionId, name, colorForIndex(characters.length));
    setNewName("");
    reload();
  }

  return (
    <div className="panel">
      <h3 className="panel-title">Characters <span className="hint">({characters.length})</span></h3>
      {characters.length === 0 && (
        <p className="hint">No characters yet — import a script or add one below.</p>
      )}
      <div className="chars">
        {characters.map((ch) => (
          <span key={ch.id} className="char-chip">
            <ColorPicker
              value={ch.color}
              onChange={async (color) => {
                await api.patchCharacter(ch.id, { color: color ?? "#888888" });
                reload();
              }}
              title={`Color for ${ch.name}`}
            />
            <span>{ch.name}</span>
            <span
              className="x muted"
              style={{ cursor: "pointer" }}
              title="Remove character"
              onClick={async () => {
                await api.deleteCharacter(ch.id);
                reload();
              }}
            >
              ×
            </span>
          </span>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input
          placeholder="Add character…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn-sm" onClick={add}>Add</button>
      </div>
    </div>
  );
}
