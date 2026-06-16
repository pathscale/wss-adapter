export { default } from './wss-adapter.js';
export { default as wssAdapter } from './wss-adapter.js';
export { WssServiceError, buildServiceError } from './errors.js';
export type {
  WssServiceErrorInit,
  ServiceErrorEnvelope,
} from './errors.js';
export type {
  IWssAdapter,
  IConfiguration,
  IServiceConfig,
  IServiceAdapter,
  IStreamingSubscriptionObserver,
  IStreamingUnsubscribe,
  IMethodInfo,
  IErrors,
  IStore,
  ApiMethods,
  ServiceName,
} from './types.js';
