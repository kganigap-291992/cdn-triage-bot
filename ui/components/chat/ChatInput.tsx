"use client";

import React from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  isLoading?: boolean;
};

export default function ChatInput({
  value,
  onChange,
  onSend,
  disabled,
  isLoading,
}: Props) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !disabled) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="w-full border-t border-white/10 bg-black/30 backdrop-blur px-4 py-3">
      <div className="w-full flex items-center gap-3">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about traffic, errors, latency..."
          disabled={disabled}
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <button
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-40"
        >
          {isLoading ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}