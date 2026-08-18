export function readSecretLine(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Secret input requires a TTY."));
  }

  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (result: { value: string } | { error: Error }) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) {
        input.pause();
      }
      process.stderr.write("\n");
      if ("error" in result) {
        reject(result.error);
      } else {
        resolve(result.value);
      }
    };

    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") {
          finish({ value });
          return;
        }
        if (character === "\u0003") {
          finish({ error: new Error("Input cancelled.") });
          return;
        }
        if (character === "\u0004") {
          finish({ value });
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    };

    input.on("data", onData);
  });
}
