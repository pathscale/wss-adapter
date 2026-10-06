# @pathscale/wss-adapter

WebSocket adapter for PathScale WSS services.

## Installation

```bash
bun add @pathscale/wss-adapter
```

## Usage

```typescript
import wssAdapter from '@pathscale/wss-adapter';

// Configure
wssAdapter.configure({
  timeout: 30000,
  services: {
    app: {
      remote: 'wss://api.example.com',
      methods: {
        '10001': { name: 'login', parameters: ['username', 'password'] },
        '10002': { name: 'getUserProfile', parameters: ['userId'] },
      },
      onDisconnect: (event) => console.log('Disconnected:', event),
    },
  },
  errors: {
    language: 'en',
    codes: [
      { code: 40001, message: 'Invalid credentials' },
      { code: 40002, message: 'Session expired' },
    ],
  },
  onError: (message) => console.error('Error:', message),
});

// Connect
const stopStatus = wssAdapter.services.app.subscribeStatus((status) => {
  console.log('Connection status:', status);
});
const result = await wssAdapter.services.app.connect(['token1', 'token2']);
console.log(wssAdapter.services.app.status); // connected

// Call methods
const profile = await wssAdapter.sessions.app.getUserProfile({ userId: '123' });
const login = await wssAdapter.sessions.app.login({ username: 'user', password: 'pass' });

// Subscribe to stream events (by method code or configured method name)
const unsubscribe = wssAdapter.subscribeTo('UserSubBulkOrderPlacedEvent', {
  next: (data) => console.log('Stream data:', data),
  error: (err) => console.error('Stream error:', err),
  complete: () => console.log('Stream completed'),
});

// Later
unsubscribe();

// Disconnect
wssAdapter.services.app.disconnect();
stopStatus();
```

Each configured service is a named `ServiceConnection` instance. It owns its socket,
sequence counter, pending calls, request and authentication timers, reconnect backoff,
and status. `configure`, `services[name].connect/disconnect/isOpen`,
`sessions[name][method]`, and `subscribeTo` remain the facade for using these instances.
Reconfiguration disconnects the previous instances and replaces the configured services.

When a socket closes (cleanly or unexpectedly), errors, or is deliberately disconnected,
only that service's pending calls reject. Other services continue normally. Deliberate
disconnects detach all socket handlers before closing and cancel scheduled reconnects.
Replacing a connection also rejects its outstanding calls. Sequence numbers increase
within an instance, including across reconnects; failed sends never reuse a number.

`service.status` is `down` initially, `reconnecting` while connecting or retrying, and
`connected` after the authentication reply. `service.subscribeStatus(callback)` immediately
reports the current status, then reports changes, and returns an unsubscribe function.
`isOpen()` reports the transport's open state; authentication may still be pending.

After transport or authentication failure, the service reconnects using the protocols and
remote from its latest `connect` call. Defaults are five consecutive retry attempts, starting
at 1 second and doubling up to 30 seconds. Successful authentication resets the retry count.
Exhausting retries sets status to `down`; deliberate disconnect also sets it to `down`.
Set `reconnect: false` to disable retries, or configure `initialDelay`, `maxDelay` (milliseconds),
and `maxAttempts` per service. `connect()` rejects if its initial connection fails; background
retries report progress through status. The configured timeout bounds authentication too.

Requests are never automatically replayed. A timeout or lost connection leaves the server-side
outcome unknown: the server may already have performed the action. Late replies cannot settle
an already rejected promise. Reconcile the outcome or use server-supported idempotency before
retrying an action that must not run twice.

Legacy configured stream callbacks run only for the service receiving the event. Facade stream
subscriptions remain an event bus across services (by method code or configured method name).
One service closing does not complete subscriptions that may still receive another service's
events; unsubscribe explicitly when finished.

## Configuration Types

```typescript
import type { WssServiceError } from '@pathscale/wss-adapter';

interface IConfiguration {
  timeout: number;
  services: Record<string, IServiceConfig>;
  errors: IErrors;
  onError?: (message: string) => void;
  onServiceError?: (error: WssServiceError) => void;
}

interface IServiceConfig {
  remote: string;
  methods: Record<string, IMethodInfo>;
  subscriptions?: Record<string, (data: any) => void>;
  onDisconnect?: (event: CloseEvent) => void;
  timeout?: number; // Overrides the global timeout for this instance, in milliseconds
  reconnect?: false | {
    initialDelay?: number;
    maxDelay?: number;
    maxAttempts?: number;
  };
}

interface IErrors {
  language: string;
  codes: IErrorCode[];
}
```

`onError` remains the legacy string callback. For WSS service-error responses, the optional
`onServiceError` callback receives the exported `WssServiceError` with structured fields
such as `code`, `kind`, `params`, `serviceMessage`, and `cause`.

Transport closes reject connection and pending-call promises with `WssTransportError`. It carries the close `code`, `wasClean`, and the pending `method` name when applicable; message text keeps the existing shape. A WebSocket `error` event waits for its paired `close` event so the close metadata survives. Authentication and request deadlines remain in force. Deliberate disconnects, timeouts, constructor failures, and server-response `WssServiceError` remain distinct; consumers should use the exported error type and fields rather than parse message text.

## Subscriptions

```typescript
services: {
  app: {
    remote: 'wss://api.example.com',
    methods: { /* ... */ },
    subscriptions: {
      'notifications': (data) => console.log('Notification:', data),
      'updates': (data) => console.log('Update:', data),
    },
  },
}
```

## Trusted npm publishing

Publishing is performed manually by `.github/workflows/publish.yml` from an exact current `master` commit and a matching `vMAJOR.MINOR.PATCH` tag. Configure npm Trusted Publishing for `pathscale/wss-adapter`, workflow `publish.yml`, and GitHub environment `npm-publish`; restrict that environment to `master`. The workflow validates the commit, tag, package version, registry state, and package contents before publishing a digest-verified tarball with provenance. It does not use an npm token or publish on tag push.

See [the npm publishing release procedure](docs/npm-publishing.md) for publisher setup and release steps.
