interface IService {
  remote: string
  methods: {
    [methodCode: string]: {
      name: string
      parameters: string[]
    }
  }
}

type ISubscriptions = Record<string, unknown>

interface IServiceConfig extends IService {
  subscriptions?: ISubscriptions
  onDisconnect: (event: {
    code: number
    reason: string
    wasClean: boolean
  }) => void | null
}
interface IServices {
  [serviceName: string]: IServiceConfig
}
interface IErrors {
  [errorCode: number]: string
}
interface IConfiguration {
  timeout: number
  services: IServices
  errors: IErrors
}
interface IServiceConnect {
  connect<T>(
    payload: string | string[] | undefined,
    remote?: string
  ): Promise<T>
  disconnect: () => void
}
interface IWssAdapter {
  services: {
    [serviceName: string]: IServiceConnect
  }
  sessions: {
    [serviceName: string]: Record<
      string,
      <Response, Params = {}>(payload?: Params) => Promise<Response>
    >
  }
  configure: (configuration: IConfiguration) => void
}
interface ISequence {
  value: number
  getSeq: () => number
  decreaseSeq: () => void
}
interface ISessions {
  [serviceName: string]: WebSocket
}
interface IPendingPromises {
  [seq: number]: {
    resolve: (payload: unknown) => void
    reject: (error: Error) => void
    toHandler: ReturnType<typeof setTimeout>
    methodName: string
  }
}
interface IStore {
  timeout: number
  errors: IErrors
  services: IServices
  sequence: ISequence
  sessions: ISessions
  subscriptions: ISubscriptions
  pendingPromises: IPendingPromises
}
export {
  IStore,
  IWssAdapter,
  IServiceConfig,
  IConfiguration,
  IErrors,
  IServices,
  IService,
}
