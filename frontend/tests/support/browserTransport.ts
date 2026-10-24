// Exercise Axios's real browser adapter with a controllable XHR boundary.
// Tests control browser events without contacting an external storage service.
export class StorageXMLHttpRequest extends EventTarget {
  static requests: StorageXMLHttpRequest[] = []

  upload = new EventTarget()
  headers: Record<string, string> = {}
  method = ''
  url = ''
  body: unknown
  timeout = 0
  withCredentials = true
  aborted = false
  status = 0
  statusText = ''
  responseText = ''

  onloadend: ((event: Event) => void) | null = null
  onabort: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  ontimeout: (() => void) | null = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  getAllResponseHeaders() {
    return ''
  }

  send(body: unknown) {
    this.body = body

    StorageXMLHttpRequest.requests.push(this)
  }

  abort() {
    this.aborted = true
    this.onabort?.()
  }

  progress(loaded: number, total?: number) {
    const event = Object.assign(new Event('progress'), {
      loaded,
      total,
      lengthComputable: total !== undefined,
    })

    this.upload.dispatchEvent(event)
  }

  complete(status = 200, body = '') {
    this.status = status
    this.responseText = body

    this.onloadend?.(new Event('loadend'))
  }

  fail(message: string) {
    this.onerror?.(Object.assign(new Event('error'), {
      message,
    }))
  }
}

Object.defineProperty(globalThis, 'XMLHttpRequest', {
  configurable: true,
  writable: true,
  value: StorageXMLHttpRequest,
})
