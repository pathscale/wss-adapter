export interface WssTransportErrorInit {
  code: number;
  wasClean: boolean;
  method?: string | undefined;
}

/** WebSocket close metadata, kept separate from server authorization errors. */
export class WssTransportError extends Error {
  readonly code: number;
  readonly wasClean: boolean;
  readonly method: string | undefined;

  constructor(message: string, init: WssTransportErrorInit) {
    super(message);
    this.name = "WssTransportError";
    this.code = init.code;
    this.wasClean = init.wasClean;
    this.method = init.method;
    Object.setPrototypeOf(this, WssTransportError.prototype);
  }

  withMethod(method: string): WssTransportError {
    return new WssTransportError(`${method}: ${this.message}`, {
      code: this.code,
      wasClean: this.wasClean,
      method,
    });
  }
}

export interface WssServiceErrorInit<TParams = unknown> {
  code?: number | undefined;
  kind?: string | undefined;
  method?: string | number | undefined;
  seq?: number | undefined;
  params?: TParams | undefined;
  serviceMessage?: string | undefined;
  raw?: unknown;
  cause?: unknown;
}

export interface ServiceErrorEnvelope {
  type?: string;
  code?: number;
  method?: number | string;
  seq?: number;
  params?: unknown;
}

const SERVICE_ERROR_FALLBACK_MESSAGE = "Service request failed";

// Preserves the service error envelope so consumers can branch on
// `code`/`kind`/`params` rather than parsing `message`. Still a plain `Error`.
export class WssServiceError<TParams = unknown> extends Error {
  readonly code: number | undefined;
  readonly kind: string | undefined;
  readonly method: string | number | undefined;
  readonly seq: number | undefined;
  readonly params: TParams | undefined;
  readonly serviceMessage: string | undefined;
  readonly raw: unknown;

  constructor(message: string, init: WssServiceErrorInit<TParams> = {}) {
    super(
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined
    );
    this.name = "WssServiceError";
    this.code = init.code;
    this.kind = init.kind;
    this.method = init.method;
    this.seq = init.seq;
    this.params = init.params;
    this.serviceMessage = init.serviceMessage;
    this.raw = init.raw;
    Object.setPrototypeOf(this, WssServiceError.prototype); // for instanceof after transpile
  }
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

// Message selection order: object params.message (or legacy reason/error),
// then string params, then catalog message, then fallback. Never stringifies
// object params.
export const buildServiceError = (
  response: ServiceErrorEnvelope,
  options: {
    methodName?: string | undefined;
    catalogMessage?: string | undefined;
  } = {}
): WssServiceError => {
  const rawParams = response.params;
  const obj =
    typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : undefined;

  const kind = obj && typeof obj.kind === "string" ? obj.kind : undefined;

  const serviceMessage =
    firstString(obj?.message, obj?.reason, obj?.error) ??
    (typeof rawParams === "string" ? rawParams : undefined);

  const message =
    serviceMessage ?? options.catalogMessage ?? SERVICE_ERROR_FALLBACK_MESSAGE;

  return new WssServiceError(message, {
    code: typeof response.code === "number" ? response.code : undefined,
    kind,
    method: response.method,
    seq: typeof response.seq === "number" ? response.seq : undefined,
    params: rawParams,
    serviceMessage,
    raw: response,
    cause: response.code,
  });
};
