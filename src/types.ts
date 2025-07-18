
export interface IMethodInfo {
  name: string;
  parameters: string[];
}

export interface IServiceConfig {
  remote: string;
  methods: Record<string, IMethodInfo>;
  subscriptions?: Record<string, (data: any) => void>;
  onDisconnect?: (event: CloseEvent) => void;
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
  timeout: number;
  errors: IErrors;
  services: Record<string, IServiceConfig>;
  subscriptions: Record<string, Record<string, (data: any) => void>>;
  sequence: {
    value: number;
    getSeq(): number;
    decreaseSeq(): void;
  };
  sessions: Record<string, WebSocket>;
  pendingPromises: Record<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      toHandler: number;
      methodName: string;
    }
  >;
  onError?: (message: string) => void;
}

export interface IServiceAdapter {
  connect: <T>(payload?: string | string[], remote?: string) => Promise<T>;
  disconnect: () => void;
}

export type ServiceName = "app";

export type ApiMethods = {
  app: Record<string, (params?: any) => Promise<any>>;
};

export interface IWssAdapter {
  services: Record<ServiceName, IServiceAdapter>;
  sessions: ApiMethods;
  configure: (configuration: IConfiguration) => void;
}