/* eslint-disable compat/compat */
/* eslint-disable promise/avoid-new */
/* eslint-disable @typescript-eslint/no-empty-function */

import { IStore, IWssAdapter, IServiceConfig } from './types'

const wssAdapter: IWssAdapter = {
  services: {},
  sessions: {},
  configure() {},
}

const store: IStore = {
  timeout: 0,
  errors: {},
  services: {},
  subscriptions: {},

  sequence: {
    value: 1,
    getSeq() {
      store.sequence.value += 1
      return store.sequence.value
    },
    decreaseSeq() {
      store.sequence.value -= 1
    },
  },

  sessions: {},
  pendingPromises: {},
}

wssAdapter.configure = (configuration) => {
  const { timeout, services, errors } = configuration

  // save some stuff for later retrieval
  store.timeout = timeout
  store.errors = errors
  store.services = services

  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    // construct services objects with two simple functions
    // intended use: `wssAdapter.services.admin.connect([1, 2, 3])` or `wssAdapter.services.auth.connect([1, 2, 3])`
    wssAdapter.services[serviceName] = {
      connect: <T>(payload: string | string[] | undefined, remote?: string) =>
        connectHandler<T>(serviceName, serviceConfig, payload, remote),
      disconnect: () => disconnectHandler(serviceName),
    }

    if (serviceConfig.subscriptions) {
      store.subscriptions[serviceName] = serviceConfig.subscriptions
    }

    // construct sessions objects that contain a proxy so you can ask unknown property
    // intended use: `wssAdapter.sessions.admin.updatePassword({ newPassword: 'hotdog6737637' })`
    wssAdapter.sessions[serviceName] = new Proxy(
      {},
      {
        get:
          (target, methodName: string) => (payload: Record<string, unknown>) =>
            sendHandler(serviceName, serviceConfig, methodName, payload),
      }
    )
  }
}

const connectHandler = <T>(
  serviceName: string,
  serviceConfig: IServiceConfig,
  payload: string | string[] | undefined,
  remote?: string
) => {
  return new Promise((resolve, reject) => {
    store.sessions[serviceName] = new WebSocket(
      remote || serviceConfig.remote,
      payload
    )

    store.sessions[serviceName].onmessage = function (event: { data: string }) {
      const response = JSON.parse(event.data)
      console.log(response)

      if (response.params.error) {
        reject(
          new Error(
            store.errors[response.params.error] ?? response.params.error
          )
        )
        return
      }

      store.sessions[serviceName].onmessage = receiveHandler
      resolve(response.params)
    }

    store.sessions[serviceName].onclose = (event) => {
      serviceConfig.onDisconnect?.(event)

      reject(
        new Error(
          `code: ${event.code}, reason: ${event.reason}, wasClean: ${event.wasClean}`
        )
      )
    }
  }) as Promise<T>
}

const disconnectHandler = (serviceName: string) => {
  store.sessions[serviceName]?.close()
}

const sendHandler = (
  serviceName: string,
  serviceConfig: IServiceConfig,
  methodName: string,
  params: Record<string, unknown> = {}
) => {
  const methodCode = Object.entries(serviceConfig.methods)
    .map(([code, info]) => ({ code, info }))
    .find(({ info }) => info.name === methodName)?.code

  if (!methodCode) {
    throw new Error(
      `method ${methodName} not available in ${serviceName} service`
    )
  }

  const payload = {
    method: Number.parseInt(methodCode),
    seq: store.sequence.getSeq(),
    params: params,
  }

  console.log(`${serviceName}::${methodName} sends:`, payload)

  return new Promise((resolve, reject) => {
    store.sessions[serviceName].send(JSON.stringify(payload))

    // save executor so that when response for this request comes the promise can be resolved
    store.pendingPromises[payload.seq] = {
      resolve,
      reject,
      toHandler: setTimeout(() => {
        reject(new Error(methodName + ' took to long, aborting'))
      }, store.timeout),
      methodName,
    }
  })
}

const receiveHandler = (event: { data: string }) => {
  const response = JSON.parse(event.data)

  if (response.method || response.method === 0) {
    console.log(
      `app::${
        store.pendingPromises[response.seq]?.methodName || response.method
      } got:`,
      response
    )

    const error = response.method === 0
    const done = response.method.toString().endsWith('1')

    const resolve = (payload: unknown, code: number) => {
      const executor = store.pendingPromises[response.seq]
      clearTimeout(store.pendingPromises[response.seq].toHandler)
      delete store.pendingPromises[response.seq]
      executor.resolve(payload)
    }

    // handle error
    if (error) {
      onError(response)
    } else if (done) {
      const code = response.method - 1
      resolve(response, code)
    }
  } else if (response.resource) {
    const resource = response.resource.split('@')[0]
    //@ts-ignore
    const executor = store.subscriptions.app[resource] as (
      payload: unknown
    ) => void
    executor?.(response)
  }
}

// if it was one of these guys
// 1) protocol violation
// 2) malformed request
// seq must be decreased

interface IResponse {
  params: {
    error: number
  }
}

function onError(response: IResponse) {
  const { error: errorCode } = response.params
  const errorMsg = store.errors[errorCode] ?? errorCode

  if ([45349638, 45349637].includes(errorCode)) {
    store.sequence.decreaseSeq()
    console.log('seq has been decreased because of error')
  }

  // if there was only one executor saved in store.pendingPromises, then it was that request that failed
  if (Object.keys(store.pendingPromises).length === 1) {
    const onlyKey = Number.parseInt(Object.keys(store.pendingPromises)[0])
    clearTimeout(store.pendingPromises[onlyKey].toHandler)
    store.pendingPromises[onlyKey].reject(new Error(errorMsg))
    delete store.pendingPromises[onlyKey]
  }

  // if there were more than one, there is no way of knowing who failed
  else {
    throw new Error('Unkown request failed')
  }
}

export default wssAdapter
