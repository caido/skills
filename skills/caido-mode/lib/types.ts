/** Shared types for caido-mode CLI */

export interface OutputOpts {
  maxBodyLines: number;
  maxBodyChars: number;
  noRequest: boolean;
  headersOnly: boolean;
}

export const DEFAULT_OUTPUT_OPTS: OutputOpts = {
  maxBodyLines: 200,
  maxBodyChars: 5000,
  noRequest: false,
  headersOnly: false,
};

export function parseOutputOpts(args: string[], startIdx: number): OutputOpts {
  const opts = { ...DEFAULT_OUTPUT_OPTS };
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--max-body" && args[i + 1]) {
      opts.maxBodyLines = parseInt(args[i + 1], 10);
      if (opts.maxBodyLines === 0) opts.maxBodyChars = 0;
      i++;
    } else if (args[i] === "--max-body-chars" && args[i + 1]) {
      opts.maxBodyChars = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--no-request") {
      opts.noRequest = true;
    } else if (args[i] === "--headers-only") {
      opts.headersOnly = true;
    } else if (args[i] === "--compact") {
      opts.noRequest = true;
      opts.maxBodyLines = 50;
      opts.maxBodyChars = 5000;
    }
  }
  return opts;
}
