import { useState, useRef } from "react";
import { Check, Plus, Trash2, Sparkles } from "lucide-react";

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

interface TodoListProps {
  todos: TodoItem[];
  onToggle: (id: string) => void;
  onAdd: (text: string) => void;
  onDelete: (id: string) => void;
  onClearCompleted?: () => void;
  accentColor: string;
  fontSizeScale?: number;
}

export function TodoList({
  todos,
  onToggle,
  onAdd,
  onDelete,
  onClearCompleted,
  accentColor,
  fontSizeScale = 1.0,
}: TodoListProps) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  const completedCount = todos.filter((t) => t.completed).length;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setInputText("");
    setTimeout(() => {
      listEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  return (
    <div className="flex flex-col h-full justify-between gap-2 overflow-hidden select-none px-4">
      {/* Scrollable Tasks Container */}
      <div className="todo-list-scroll flex-1 overflow-y-auto pr-1 space-y-1.5 max-h-[175px] scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {todos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-6 text-neutral-500 gap-1.5">
            <Sparkles className="w-5 h-5 text-neutral-600" />
            <span
              className="text-xs font-mono"
              style={{ fontSize: `${12 * fontSizeScale}px` }}
            >
              No tasks yet. Add one below!
            </span>
          </div>
        ) : (
          todos.map((todo) => (
            <div
              key={todo.id}
              onClick={() => onToggle(todo.id)}
              className="group flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.04] transition-all cursor-pointer"
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                {/* Custom Checkbox */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(todo.id);
                  }}
                  className={`w-4 h-4 rounded-md flex items-center justify-center transition-all shrink-0 ${
                    todo.completed
                      ? "border border-transparent shadow-sm"
                      : "border border-neutral-600 hover:border-neutral-400 bg-black/20"
                  }`}
                  style={
                    todo.completed
                      ? { backgroundColor: accentColor }
                      : undefined
                  }
                >
                  {todo.completed && (
                    <Check className="w-2.5 h-2.5 text-black stroke-[3.5]" />
                  )}
                </button>

                {/* Task Text */}
                <span
                  className={`truncate transition-all ${
                    todo.completed
                      ? "text-neutral-500 line-through"
                      : "text-neutral-200"
                  }`}
                  style={{
                    fontSize: `${12.5 * fontSizeScale}px`,
                  }}
                >
                  {todo.text}
                </span>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(todo.id);
                  }}
                  title="Delete task"
                  className="p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
        <div ref={listEndRef} />
      </div>

      {/* Input Bar & Footer Controls */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 pt-1 border-t border-white/5"
      >
        <div className="flex-1 flex items-center bg-white/[0.06] rounded-lg px-2.5 py-1.5 border border-white/5 focus-within:border-white/20 transition-colors">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Add new task... (Press Enter)"
            className="w-full bg-transparent text-neutral-200 placeholder-neutral-500 text-xs focus:outline-none"
            style={{ fontSize: `${12 * fontSizeScale}px` }}
          />
        </div>

        <button
          type="submit"
          disabled={!inputText.trim()}
          className="p-1.5 rounded-lg text-black font-medium transition-all disabled:opacity-30 disabled:pointer-events-none"
          style={{ backgroundColor: accentColor }}
          title="Add task"
        >
          <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
        </button>

        {completedCount > 0 && onClearCompleted && (
          <button
            type="button"
            onClick={onClearCompleted}
            title="Clear completed tasks"
            className="text-[10px] font-mono text-neutral-500 hover:text-neutral-300 px-1 py-1 rounded hover:bg-white/5 transition-colors whitespace-nowrap"
          >
            Clear done
          </button>
        )}
      </form>
    </div>
  );
}
