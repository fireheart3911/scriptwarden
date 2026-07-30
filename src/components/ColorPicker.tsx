import { useEffect, useRef, useState } from "react";
import { PALETTE } from "../lib/colors";

interface Props {
  value: string | null;
  onChange: (color: string | null) => void;
  allowClear?: boolean; // show a "use default" option (for per-line overrides)
  title?: string;
}

// A swatch that opens a small palette popover. Used for speaker colors and
// per-line color overrides.
export function ColorPicker({ value, onChange, allowClear, title }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <span
        className="swatch"
        title={title ?? "Set color"}
        style={{ background: value ?? "transparent", borderStyle: value ? "solid" : "dashed" }}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="color-pop">
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className="swatch-btn"
                style={{ background: c }}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="row">
            <input
              type="color"
              value={value ?? "#888888"}
              onChange={(e) => onChange(e.target.value)}
              style={{ width: 40, padding: 2, height: 30 }}
            />
            {allowClear && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                Use default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
