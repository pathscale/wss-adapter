# @pathscale/wss-adapter

WebSocket adapter for PathScale WSS services.

## Installation

```bash
npm install @pathscale/wss-adapter
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
const result = await wssAdapter.services.app.connect(['token1', 'token2']);

// Call methods
const profile = await wssAdapter.sessions.app.getUserProfile({ userId: '123' });
const login = await wssAdapter.sessions.app.login({ username: 'user', password: 'pass' });

// Disconnect
wssAdapter.services.app.disconnect();
```

## Configuration Types

```typescript
interface IConfiguration {
  timeout: number;
  services: Record<string, IServiceConfig>;
  errors: IErrors;
  onError?: (message: string) => void;
}

interface IServiceConfig {
  remote: string;
  methods: Record<string, IMethodInfo>;
  subscriptions?: Record<string, (data: any) => void>;
  onDisconnect?: (event: CloseEvent) => void;
}

interface IErrors {
  language: string;
  codes: IErrorCode[];
}
```

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

That's it.