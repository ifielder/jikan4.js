import HTTP from 'http'
import HTTPS from 'https'
import Path from 'path'

import { Client } from '../core/client'
import { URL } from 'url'
import { waitUntil } from '../utils'
import { CacheManager } from './cache'

export interface APIRequestQuery {
  disableCaching?: string

  [key: string]: string | undefined
}

export interface APIRequestData {
  path: string
  query?: APIRequestQuery
  cache?: boolean
}

export class APIResponseData {
  private static parsePagination (url: URL, paginationData: any) {
    const current = Number(url.searchParams.get('page')) || 1
    const last = paginationData?.last_visible_page || 1
    const hasNext = paginationData?.has_next_page || false

    return { current, last, hasNext }
  }

  public constructor (status: number, url: URL, headers: HTTP.IncomingHttpHeaders, body: any) {
    this.time = Date.now()
    this.url = `${url.href}`
    this.status = status || 200
    this.headers = headers
    this.body = body
    this.pagination = body?.pagination
      ? APIResponseData.parsePagination(url, body.pagination)
      : undefined
  }

  public readonly url: string
  public readonly status: number
  public readonly body: any
  public readonly time: number
  public readonly headers: HTTP.IncomingHttpHeaders
  public readonly pagination?: {
    current: number
    last: number
    hasNext: boolean
  }
}

export class APIError extends Error {
  public constructor (response: APIResponseData) {
    const { status, url: referenceUrl, body: { type, message, error, trace, report_url: reportUrl } } = response
    if (!error) {
      throw new Error('Invalid error data')
    }

    super(`HTTP ${status} Hit: ${message}`)

    this.status = status
    this.errorType = type
    this.error = error
    this.trace = trace
    this.reportUrl = reportUrl
    this.referenceUrl = referenceUrl
    this.response = response
  }

  public readonly status: number
  public readonly errorType: string
  public readonly error: string
  public readonly trace: string
  public readonly reportUrl: string
  public readonly referenceUrl: string
  public readonly response: APIResponseData
}

export class APIClient {
  public constructor (client: Client) {
    this.client = client
    this.queue = []
    this.cache = !client.options.disableCaching
      ? new CacheManager(client)
      : undefined

    this.lastRequest = 0
    this.isQueueRunning = false
    this.agent = (() => {
      const { options: { keepAlive, keepAliveMsecs } } = client
      const options = { keepAlive, keepAliveMsecs }

      return {
        http: new HTTP.Agent(options),
        https: new HTTPS.Agent(options)
      }
    })()
  }

  public readonly client: Client
  public readonly queue: Array<{
    requestData: APIRequestData

    resolve: (data: APIResponseData) => void
    reject: (error: Error | APIError) => void
  }>

  public readonly cache?: CacheManager
  public readonly agent: {
    http: HTTP.Agent
    https: HTTPS.Agent
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private newRequestInstance (secure: boolean, url: URL, options: HTTP.RequestOptions | HTTPS.RequestOptions) {
    const { agent } = this

    if (secure) {
      return HTTPS.request(url, { ...options, agent: agent.https })
    }

    return HTTP.request(url, { ...options, agent: agent.http })
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private lastRequest: number

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private get nextRequest (): number {
    const { client: { options: { dataRateLimit } }, lastRequest } = this

    return lastRequest + dataRateLimit
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private async awaitNextRequest () {
    const { nextRequest } = this

    if (nextRequest > Date.now()) {
      this.debug(`Wait ${nextRequest - Date.now()} ms before requesting`)
      await waitUntil(nextRequest)
    }
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private isQueueRunning: boolean

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private async runQueue () {
    if (this.isQueueRunning) {
      return
    }

    this.isQueueRunning = true
    try {
      const { queue } = this

      while (queue.length) {
        const entry = <this['queue'][0]> queue.shift()
        this.debug(`Queue size update: ${queue.length}`)
        const { requestData, resolve, reject } = entry

        try {
          const responseData = await this.execReqeust(requestData)
          for (let queueIndex = 0; queue.length > queueIndex; queueIndex++) {
            const otherEntry = queue[queueIndex]
            const { requestData: { path: otherPath, query: otherQuery } } = otherEntry
            const { path, query } = requestData

            if (JSON.stringify([otherPath, otherQuery]) === JSON.stringify([path, query])) {
              queue.splice(queueIndex--, 1)

              resolve(responseData)
            }
          }

          resolve(responseData)
        } catch (error: any) {
          reject(error)
        }
      }
    } finally {
      this.isQueueRunning = false
    }
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private addQueue (requestData: APIRequestData, resolve: (data: APIResponseData) => void, reject: (error: Error | APIError) => void) {
    const { queue } = this
    queue.push({ requestData, resolve, reject })
    this.debug(`Queue size update: ${queue.length}`)

    if (!this.isQueueRunning) {
      this.runQueue()
    }
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private debug (message: string) {
    return this.client.debug('API Client', message)
  }

  public constructURL (requestData: APIRequestData) {
    const { client: { options: { host, baseUri, secure } } } = this
    const { path, query } = requestData
    const url = new URL(`http${secure ? 's' : ''}://${host}${((path) => `${path.startsWith('/') ? '' : '/'}${path}`)(Path.join(baseUri, path))}`)
    const { searchParams } = url

    if (query) {
      for (const queryKey in query) {
        const { [queryKey]: queryEntry } = query

        if (queryEntry) {
          searchParams.set(queryKey, queryEntry)
        }
      }
    }

    return url
  }

  public async request (requestData: APIRequestData) {
    const { cache } = this

    if ((requestData.cache !== undefined ? requestData.cache : true) && cache?.has(requestData)) {
      return <APIResponseData> cache.get(requestData)
    }

    return await new Promise<APIResponseData>((resolve, reject) => this.addQueue(requestData, resolve, reject))
  }

  // eslint-disable-next-line tsdoc/syntax
  /** @hidden */
  private async execReqeust (requestData: APIRequestData) {
    const { client: { options: { secure, requestTimeout, maxApiErrorRetry, retryOnApiError } }, cache } = this
    const url = this.constructURL(requestData)
    const cachingEnabled = requestData.cache !== undefined ? requestData.cache : true

    const run = () => new Promise<APIResponseData>((resolve, reject) => {
      if (cachingEnabled && cache?.has(requestData)) {
        return cache.get(requestData)
      }

      this.lastRequest = Date.now()
      this.debug(`HTTP GET ${url}`)
      const request = this.newRequestInstance(secure, url, { timeout: requestTimeout })
      request.on('error', reject)
      request.on('timeout', () => request.destroy(new Error(`${requestTimeout} ms timeout`)))
      request.on('response', async (response) => {
        response.on('error', reject)
        const bufferSink: Array<Buffer> = []

        for await (const buffer of response) {
          bufferSink.push(buffer)
        }

        const body = JSON.parse(Buffer.concat(bufferSink).toString('utf-8'))
        const responseData = new APIResponseData(Number(body.status || response.statusCode), url, response.headers, body)

        if ([418, 200, 404].includes(responseData.status)) {
          if (cachingEnabled) {
            cache?.set(requestData, responseData)
          }

          resolve(responseData)
        } else if (responseData.status === 429) {
          reject(new APIError(Object.assign(responseData, {
            body: Object.assign(responseData.body, {
              error: 'Rate limited'
            })
          })))
        } else {
          reject(new APIError(responseData))
        }
      })

      request.end()
    })

    return new Promise<APIResponseData>((resolve, reject) => {
      let retry: number = 0
      const exec = async () => {
        await this.awaitNextRequest()
        await run()
          .then(resolve)
          .catch((error) => {
            if (!(
              retryOnApiError &&
              (retry <= maxApiErrorRetry) &&
              (
                error.response
                  ? (
                      (error.response.status >= 500) &&
                      (error.response.status < 600)
                    )
                  : true
              )
            )) {
              reject(error)
            } else {
              retry++
              exec()
            }
          })
      }

      exec()
    })
  }
}
