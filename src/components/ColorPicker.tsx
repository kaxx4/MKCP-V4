import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}

const PRESET_COLORS = [
  { name: "Blue", hex: "#3b82f6" },
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Orange", hex: "#f97316" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Fuchsia", hex: "#ec4899" },
  { name: "Lime", hex: "#84cc16" },
  { name: "Red", hex: "#ef4444" },
  { name: "Green", hex: "#10b981" },
];

export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {label && <label className="text-sm font-medium text-neutral-700">{label}</label>}
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={clsx(
            "flex items-center gap-2 w-full px-3 py-2 rounded-lg border transition-colors",
            "bg-white border-neutral-200 hover:border-neutral-300",
            isOpen && "ring-2 ring-accent/20 border-accent"
          )}
        >
          <div
            className="w-6 h-6 rounded border border-neutral-200"
            style={{ backgroundColor: value || "#3b82f6" }}
            aria-hidden="true"
          />
          <input
            type="text"
            value={value || "#3b82f6"}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#3b82f6"
            className="flex-1 text-sm bg-transparent focus:outline-none font-mono"
          />
          <ChevronDown
            size={16}
            className={clsx(
              "text-neutral-400 transition-transform",
              isOpen && "rotate-180"
            )}
          />
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 right-0 mt-2 p-3 bg-white border border-neutral-200 rounded-lg shadow-lg z-10">
            <div className="grid grid-cols-4 gap-2">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.hex}
                  onClick={() => {
                    onChange(color.hex);
                    setIsOpen(false);
                  }}
                  className={clsx(
                    "w-full h-10 rounded-lg border-2 transition-[border-color,transform]",
                    "hover:scale-105 active:scale-95",
                    value === color.hex
                      ? "border-neutral-900 ring-2 ring-accent"
                      : "border-neutral-200 hover:border-neutral-300"
                  )}
                  style={{ backgroundColor: color.hex }}
                  title={color.name}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
