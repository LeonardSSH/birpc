export type ArgumentsType<T> = T extends (...args: infer A) => any ? A : never
export type ReturnType<T> = T extends (...args: any) => infer R ? R : never

export interface ChannelOptions {
  /**
   * Function to post raw message
   */
  post: (data: any, ...extras: any[]) => void
  /**
   * Listener to receive raw message
   */
  on: (fn: (data: any, ...extras: any[]) => void) => void
  /**
   * Custom function to serialize data
   *
   * by default it passes the data as-is
   */
  serialize?: (data: any) => any
  /**
   * Custom function to deserialize data
   *
   * by default it passes the data as-is
   */
  deserialize?: (data: any) => any
}

export interface EventOptions<Remote> {
  /**
   * Names of remote functions that do not need response.
   */
  eventNames?: (keyof Remote)[]

  /**
   * Maximum timeout for waiting for response, in milliseconds.
   *
   * @default 60_000
   */
  timeout?: number
}

export type BirpcOptions<Remote> = EventOptions<Remote> & ChannelOptions

export interface BirpcFn<T> {
  /**
   * Call the remote function and wait for the result.
   */
  (...args: ArgumentsType<T>): Promise<Awaited<ReturnType<T>>>
  /**
   * Send event without asking for response
   */
  asEvent(...args: ArgumentsType<T>): void
}

export interface BirpcGroupFn<T> {
  /**
   * Call the remote function and wait for the result.
   */
  (...args: ArgumentsType<T>): Promise<Awaited<ReturnType<T>>[]>
  /**
   * Send event without asking for response
   */
  asEvent(...args: ArgumentsType<T>): void
}

export type BirpcReturn<RemoteFunctions> = {
  [K in keyof RemoteFunctions]: BirpcFn<RemoteFunctions[K]>
}

export type BirpcGroupReturn<RemoteFunctions> = {
  [K in keyof RemoteFunctions]: BirpcGroupFn<RemoteFunctions[K]>
}

interface Request {
  /**
   * Type
   */
  t: 'q'
  /**
   * ID
   */
  i?: string
  /**
   * Method
   */
  m: string
  /**
   * Arguments
   */
  a: any[]
}

interface Response {
  /**
   * Type
   */
  t: 's'
  /**
   * Id
   */
  i: string
  /**
   * Result
   */
  r?: any
  /**
   * Error
   */
  e?: any
}

type RPCMessage = Request | Response

export const DEFAULT_TIMEOUT = 60_000 // 1 minute

export function createBirpc<RemoteFunctions = {}, LocalFunctions = {}>(
  functions: LocalFunctions,
  options: BirpcOptions<RemoteFunctions>,
): BirpcReturn<RemoteFunctions> {
  const {
    post,
    on,
    eventNames = [],
    serialize = i => i,
    deserialize = i => i,
    timeout = DEFAULT_TIMEOUT,
  } = options

  const rpcPromiseMap = new Map<string, { resolve: Function; reject: Function }>()

  const rpc = new Proxy({}, {
    get(_, method: string) {
      const sendEvent = (...args: any[]) => {
        post(serialize(<Request>{ m: method, a: args, t: 'q' }))
      }
      if (eventNames.includes(method as any)) {
        sendEvent.asEvent = sendEvent
        return sendEvent
      }
      const sendCall = (...args: any[]) => {
        return new Promise((resolve, reject) => {
          const id = nanoid()
          rpcPromiseMap.set(id, { resolve, reject })
          post(serialize(<Request>{ m: method, a: args, i: id, t: 'q' }))
          if (timeout >= 0) {
            setTimeout(() => {
              reject(new Error(`[birpc] timeout on calling "${method}"`))
              rpcPromiseMap.delete(id)
            }, timeout)
          }
        })
      }
      sendCall.asEvent = sendEvent
      return sendCall
    },
  }) as BirpcReturn<RemoteFunctions>

  on(async(data, ...extra) => {
    const msg = deserialize(data) as RPCMessage
    if (msg.t === 'q') {
      const { m: method, a: args } = msg
      let result, error: any
      try {
        // @ts-expect-error casting
        result = await (functions[method]).call(rpc, args)
      }
      catch (e) {
        error = e
      }
      if (msg.i)
        post(serialize(<Response>{ t: 's', i: msg.i, r: result, e: error }), ...extra)
    }
    else {
      const { i: ack, r: result, e: error } = msg
      const promise = rpcPromiseMap.get(ack)
      if (error)
        promise?.reject(error)
      else
        promise?.resolve(result)
      rpcPromiseMap.delete(ack)
    }
  })

  return rpc
}

const cacheMap = new WeakMap<any, any>()
export function cachedMap<T, R>(items: T[], fn: ((i: T) => R)): R[] {
  return items.map((i) => {
    let r = cacheMap.get(i)
    if (!r) {
      r = fn(i)
      cacheMap.set(i, r)
    }
    return r
  })
}

export function createBirpcGroup<RemoteFunctions = {}, LocalFunctions = {}>(
  functions: LocalFunctions,
  channels: ChannelOptions[],
  options: EventOptions<RemoteFunctions> = {},
) {
  const getClients = () => cachedMap(channels, s => createBirpc(functions, { ...options, ...s }))

  const boardcastProxy = new Proxy({}, {
    get(_, method) {
      const client = getClients()
      const functions = client.map(c => (c as any)[method])
      const sendCall = (...args: any[]) => {
        return Promise.all(functions.map(i => i(...args)))
      }
      sendCall.asEvent = (...args: any[]) => {
        functions.map(i => i.asEvent(...args))
      }
      return sendCall
    },
  }) as BirpcGroupReturn<RemoteFunctions>

  function updateChannels(fn?: ((channels: ChannelOptions[]) => void)) {
    fn?.(channels)
    return getClients()
  }

  getClients()

  return {
    get clients() {
      return getClients()
    },
    updateChannels,
    boardcast: boardcastProxy,
  }
}

// port from nanoid
// https://github.com/ai/nanoid
const urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
function nanoid(size = 21) {
  let id = ''
  let i = size
  while (i--)
    id += urlAlphabet[(Math.random() * 64) | 0]
  return id
}
