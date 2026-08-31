/**
 * Everything the editor has said, kept rather than shown once and lost.
 *
 * `Notices.svelte` is the strip that catches a designer's eye and is dismissed; this is the record behind
 * it. The two answer different questions — "something is wrong right now" and "what did it say twenty
 * minutes ago, when the wall went black" — and the second one is the one that gets asked while debugging a
 * map, which is why the notice being dismissable had to stop meaning the message was gone.
 *
 * The browser's own console is not enough, for one reason: this editor draws through WebGPU, and the
 * warnings that matter most — a shader that failed to compile, a texture that never loaded — arrive there
 * mixed into whatever else the page is doing, in a panel a designer using the app has no reason to have
 * open. So `console.warn` and `console.error` are forwarded here as well as through, and an uncaught error
 * anywhere on the page lands here too.
 *
 * A repeated line becomes a count rather than another row. A shader warning fired from inside the animation
 * loop would otherwise fill four hundred rows in seven seconds and push out everything that led to it.
 */

export type Level = "note" | "warn" | "bad";

export type Line = {
  at: number;
  level: Level;
  text: string;
  /** how many times in a row this same line has been said */
  count: number;
};

/** enough to hold the run-up to whatever went wrong, small enough that showing all of it is instant */
const CAP = 400;

const RANK: Record<Level, number> = { note: 0, warn: 1, bad: 2 };

class Log {
  #lines = $state.raw<Line[]>([]);
  /** how many lines have arrived since the drawer was last looked at, and the worst of them */
  #unread = $state(0);
  #unreadLevel = $state<Level>("note");
  #watching = false;

  get lines(): readonly Line[] {
    return this.#lines;
  }

  get unread(): number {
    return this.#unread;
  }

  /** the worst thing said since the drawer was last read, which is what colours the button */
  get pending(): Level | undefined {
    return this.#unread ? this.#unreadLevel : undefined;
  }

  say(text: string): void {
    this.#add("note", text);
  }

  warn(text: string): void {
    this.#add("warn", text);
  }

  bad(text: string): void {
    this.#add("bad", text);
  }

  /** several at once, from something that answers with a list — a save's problems, an open's diagnostics */
  all(level: Level, texts: readonly string[]): void {
    for (const text of texts) this.#add(level, text);
  }

  read(): void {
    this.#unread = 0;
    this.#unreadLevel = "note";
  }

  clear(): void {
    this.#lines = [];
    this.read();
  }

  #add(level: Level, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    const last = this.#lines[this.#lines.length - 1];
    if (last && last.text === trimmed && last.level === level) {
      // a new array, because the rows are `$state.raw` and a mutated last row is a row nothing redraws
      this.#lines = [...this.#lines.slice(0, -1), { ...last, at: Date.now(), count: last.count + 1 }];
    } else {
      const line: Line = { at: Date.now(), level, text: trimmed, count: 1 };
      this.#lines = [...this.#lines.slice(Math.max(0, this.#lines.length - CAP + 1)), line];
    }

    this.#unread++;
    if (RANK[level] > RANK[this.#unreadLevel]) this.#unreadLevel = level;
  }

  /**
   * Start catching what the page says.
   *
   * Called once, from the shell. The originals are called first and always: a console this forwards to but
   * does not replace is a console the browser's own devtools still work in, and swallowing a warning to put
   * it in a panel of ours would be a straight downgrade for anyone with devtools open.
   */
  watch(): void {
    if (this.#watching || typeof window === "undefined") return;
    this.#watching = true;

    const forward = (level: Level, original: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        original(...args);
        this.#add(level, args.map(said).join(" "));
      };
    console.warn = forward("warn", console.warn.bind(console));
    console.error = forward("bad", console.error.bind(console));

    addEventListener("error", (event) => this.#add("bad", event.message || String(event.error)));
    addEventListener("unhandledrejection", (event) => this.#add("bad", `unhandled: ${said(event.reason)}`));
  }
}

/** an argument as a line, without a whole formatter: objects are one line of JSON or their own name */
function said(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export const log = new Log();
