import { useEffect, useRef } from "react";
import type { LogLine } from "../types.ts";

export function LogPane({ lines }: { lines: LogLine[] }): JSX.Element | null {
  const bottom = useRef<HTMLDivElement>(null);
  const count = lines.length;
  useEffect(() => {
    if (count > 0) {
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [count]);
  if (lines.length === 0) {
    return null;
  }
  return (
    <section className="card log">
      <h3>Activity</h3>
      <div className="log-lines">
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
          <div key={index} className={`log-line ${line.stream}`}>
            {line.line}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </section>
  );
}
