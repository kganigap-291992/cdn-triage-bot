type NextActionChip = {
  id: string;
  label: string;
  query: string;
};

export default function NextActionChips({
  actions,
  onSelect,
}: {
  actions: NextActionChip[];
  onSelect: (query: string) => void;
}) {
  if (!actions?.length) return null;

  return (
    <div className="mt-3 flex flex-col items-end gap-1.5">
      {/* subtle helper text */}
      <div className="text-[11px] text-gray-500 pr-1">
        Try asking this next
      </div>

      {/* chips */}
      <div className="flex flex-wrap justify-end gap-2.5">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => onSelect(action.query)}
            className="max-w-fit rounded-full border border-white/6 bg-white/[0.04] px-4 py-2.5 text-sm text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-white/10 hover:bg-white/[0.08] active:scale-[0.99]"
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}