export interface IMethodInfo {
  name: string;
  parameters: string[];
}

export interface IServiceConfig {
  remote: string;
  methods: Record<string, IMethodInfo>;
  subscriptions?: Record<string, (data: any) => void>;
  onDisconnect?: (event: CloseEvent) => void;
  timeout?: number;
  reconnect?: false | { initialDelay?: number; maxDelay?: number; maxAttempts?: number };
}

export interface IErrorCode {
  code: number;
  message: string;
}

export interface IErrors {
  language: string;
  codes: IErrorCode[];
}

export interface IConfiguration {
  timeout: number;
  services: Record<string, IServiceConfig>;
  errors: IErrors;
  onError?: (message: string) => void;
}

export interface IStore {
  connections: Record<string, IServiceAdapter>;
}

export type ServiceStatus = 'connected' | 'reconnecting' | 'down';

export interface IServiceAdapter {
  readonly name: string;
  readonly status: ServiceStatus;
  subscribeStatus: (observer: (status: ServiceStatus) => void) => () => void;
  connect: <T>(payload?: string | string[], remote?: string) => Promise<T>;
  disconnect: () => void;
  isOpen: () => boolean;
}

export interface IStreamingSubscriptionObserver<TEvent = unknown> {
  next: (data: TEvent) => void;
  error?: (err: Error) => void;
  complete?: () => void;
}

export type IStreamingUnsubscribe = () => void;

export type ServiceName = string;

export type ApiMethods = {
  app: Record<string, (params?: any) => Promise<any>>;
  [service: string]: Record<string, (params?: any) => Promise<any>>;
};

export interface IWssAdapter {
  services: Record<ServiceName, IServiceAdapter> & { app: IServiceAdapter };
  sessions: ApiMethods;
  configure: (configuration: IConfiguration) => void;
  subscribeTo: <TEvent = unknown>(
    event: string,
    observer: IStreamingSubscriptionObserver<TEvent>
  ) => IStreamingUnsubscribe;
  __store: IStore;
}
