import { StorageXMLHttpRequest } from './support/browserTransport'

import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { AxiosError, AxiosHeaders, CanceledError } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from 'vite'

import { apiHttp, storageHttp } from '../src/api/http'
import {
  requestUploadAuthorization,
  uploadFileToStorage,
  UploadTransportError,
} from '../src/components/PdfUpload/uploadTransport'

import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import type { UploadAuthorization } from '../src/components/PdfUpload/PdfUpload.types'

const authorization: UploadAuthorization = {
  uploadId: 'opaque-upload-id',
  method: 'PUT',
  url: 'https://storage.example.test/staging/opaque.pdf?X-Amz-Signature=secret%2Bvalue&part=1',

  headers: {
    'Content-Type': 'application/pdf',
    'x-amz-meta-upload-id': 'opaque-upload-id',
  },

  expiresAt: '2026-10-21T00:05:00.000Z',
}

const file = new File(['%PDF-1.7\nraw bytes\0'], 'notes.pdf', {
  type: 'application/pdf',
})

const apiDefaults = {
  ...apiHttp.defaults,

  headers: {
    ...apiHttp.defaults.headers,
    common: { ...apiHttp.defaults.headers.common },
  },
}

afterEach(() => {
  delete apiHttp.defaults.auth
  delete apiHttp.defaults.params

  Object.assign(apiHttp.defaults, {
    ...apiDefaults,

    headers: {
      ...apiDefaults.headers,
      common: { ...apiDefaults.headers.common },
    },
  })

  apiHttp.interceptors.request.clear()
  apiHttp.interceptors.response.clear()

  StorageXMLHttpRequest.requests = []

  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function apiResponse(config: InternalAxiosRequestConfig, data: unknown) {
  return {
    config,
    data,
    status: 201,
    statusText: 'Created',
    headers: new AxiosHeaders(),
  }
}

async function storageRequest() {
  await vi.waitFor(() => {
    expect(StorageXMLHttpRequest.requests).toHaveLength(1)
  })

  return StorageXMLHttpRequest.requests[0]
}

describe('development API routing', () => {
  it('proxies /api to the host Express server without rewriting the route', async () => {
    const config = await resolveConfig({}, 'serve')

    expect(config.server.proxy?.['/api']).toEqual({
      target: 'http://localhost:3000',
      changeOrigin: true,
    })
  })

  it('uses the documented public API prefix and supports an explicit override', async () => {
    const example = parseEnv(readFileSync('.env.example', 'utf8'))
    const documentation = readFileSync('README.md', 'utf8')

    expect(example).toEqual({
      VITE_API_BASE_URL: '/api',
    })

    expect(documentation).toContain('http://localhost:3000')
    expect(documentation).toContain('VITE_API_BASE_URL')

    vi.stubEnv('VITE_API_BASE_URL', '')
    vi.resetModules()

    const defaultHttp = await import('../src/api/http')

    expect(defaultHttp.apiHttp.getUri({ url: '/uploads/presign' }))
      .toBe('/api/uploads/presign')

    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/api')
    vi.resetModules()

    const customHttp = await import('../src/api/http')

    expect(customHttp.apiHttp.getUri({ url: '/uploads/presign' }))
      .toBe('https://api.example.test/api/uploads/presign')
  })
})

describe('upload authorization', () => {
  it.each(['application/pdf', ''])('posts only metadata and normalizes media type %j', async (contentType) => {
    let captured: InternalAxiosRequestConfig | undefined

    apiHttp.defaults.adapter = (config) => {
      captured = config

      return Promise.resolve(apiResponse(config, authorization))
    }

    const controller = new AbortController()

    const result = await requestUploadAuthorization({
      filename: file.name,
      size: file.size,
      contentType,
    }, {
      signal: controller.signal,
    })

    expect(result).toEqual(authorization)
    expect(apiHttp.getUri(captured)).toBe('/api/uploads/presign')
    expect(captured?.method).toBe('post')
    expect(captured?.signal).toBe(controller.signal)
    expect(captured?.timeout).toBe(15_000)

    expect(JSON.parse(captured?.data)).toEqual({
      filename: 'notes.pdf',
      size: file.size,
      contentType: 'application/pdf',
    })
  })

  it('normalizes API failure bodies without retaining diagnostics', async () => {
    apiHttp.defaults.adapter = (config) => Promise.reject(new AxiosError(
      authorization.url,
      'ERR_BAD_RESPONSE',
      config,
      undefined,
      {
        ...apiResponse(config, { error: { message: authorization.url } }),
        status: 503,
      },
    ))

    await expect(requestUploadAuthorization({
      filename: file.name,
      size: file.size,
      contentType: file.type,
    }, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'authorization',
      message: 'Could not authorize the upload. Check the PDF and try again.',
    })
  })

  it('aborts an active authorization request with the caller signal', async () => {
    const started = Promise.withResolvers<void>()

    apiHttp.defaults.adapter = (config) => new Promise((_resolve, reject) => {
      config.signal?.addEventListener('abort', () => {
        reject(new CanceledError(authorization.url, config))
      })

      started.resolve()
    })

    const controller = new AbortController()

    const pending = requestUploadAuthorization({
      filename: file.name,
      size: file.size,
      contentType: file.type,
    }, {
      signal: controller.signal,
    })

    const assertion = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Upload cancelled.',
    })

    await started.promise
    controller.abort()
    await assertion
  })
})

describe('direct storage transfer', () => {
  it('sends exact signed URL, raw bytes and required headers without API configuration', async () => {
    const apiInterceptor = vi.fn((config: InternalAxiosRequestConfig) => {
      config.headers.set('X-API-Interceptor', 'private')

      return config
    })

    apiHttp.interceptors.request.use(apiInterceptor)
    apiHttp.defaults.baseURL = 'https://api.example.test/private'
    apiHttp.defaults.headers.common.Authorization = 'Bearer api-secret'
    apiHttp.defaults.withCredentials = true
    apiHttp.defaults.auth = { username: 'api-user', password: 'api-password' }
    apiHttp.defaults.params = { apiOnly: true }
    apiHttp.defaults.transformRequest = [() => 'api-body']

    const pending = uploadFileToStorage(file, authorization, {
      signal: new AbortController().signal,
    })

    const request = await storageRequest()

    expect(request.url).toBe(authorization.url)
    expect(request.method).toBe('PUT')
    expect(request.headers).toEqual({
      'Content-Type': 'application/pdf',
      'x-amz-meta-upload-id': 'opaque-upload-id',
    })

    expect(request.body).toBe(file)
    expect(await (request.body as File).arrayBuffer()).toEqual(await file.arrayBuffer())
    expect(request.withCredentials).toBe(false)
    expect(request.timeout).toBe(120_000)
    expect(apiInterceptor).not.toHaveBeenCalled()
    expect(authorization.headers).toEqual({
      'Content-Type': 'application/pdf',
      'x-amz-meta-upload-id': 'opaque-upload-id',
    })

    request.complete()
    await pending
  })

  it('reports progress while waiting for the successful storage response', async () => {
    const progress = vi.fn()
    let settled = false

    const pending = uploadFileToStorage(file, authorization, {
      signal: new AbortController().signal,
      onProgress: progress,
    }).then(() => {
      settled = true
    })

    const request = await storageRequest()

    request.progress(file.size, file.size)

    await vi.waitFor(() => {
      expect(progress).toHaveBeenCalledWith({
        loaded: file.size,
        total: file.size,
      })
    })

    expect(settled).toBe(false)

    request.complete()
    await pending

    expect(settled).toBe(true)
  })

  it('uses the known file size when the browser reports indeterminate progress', async () => {
    const progress = vi.fn()

    const pending = uploadFileToStorage(file, authorization, {
      signal: new AbortController().signal,
      onProgress: progress,
    })

    const request = await storageRequest()

    request.progress(5)
    request.complete()
    await pending

    expect(progress).toHaveBeenCalledWith({
      loaded: 5,
      total: file.size,
    })
  })

  it('does not dispatch storage work for an already aborted signal', async () => {
    const controller = new AbortController()

    controller.abort()

    await expect(uploadFileToStorage(file, authorization, {
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Upload cancelled.',
    })

    expect(StorageXMLHttpRequest.requests).toHaveLength(0)
  })

  it('normalizes the browser storage timeout event', async () => {
    const pending = uploadFileToStorage(file, authorization, {
      signal: new AbortController().signal,
    })

    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
      message: 'Upload request timed out. Try again.',
    })

    const request = await storageRequest()

    expect(request.timeout).toBe(120_000)

    request.ontimeout?.()
    await assertion
  })

  it('aborts an active storage request with no signed URL in the error', async () => {
    const controller = new AbortController()

    const pending = uploadFileToStorage(file, authorization, {
      signal: controller.signal,
    })

    const assertion = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Upload cancelled.',
    })

    const request = await storageRequest()

    controller.abort()
    await assertion

    expect(request.aborted).toBe(true)
  })

  it.each(['rejected', 'network'])('normalizes %s storage failures without leaking URL/config', async (failure) => {
    const pending = uploadFileToStorage(file, authorization, {
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught)

    const request = await storageRequest()

    if (failure === 'network') {
      request.fail(`Network failed: ${authorization.url}`)
    } else {
      request.complete(403, authorization.url)
    }

    const error = await pending

    expect(error).toBeInstanceOf(UploadTransportError)
    expect(error).toMatchObject({
      code: 'storage',
      message: 'Could not upload the PDF to storage. Check your connection and try again.',
    })

    expect(String(error)).not.toContain('storage.example.test')
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('response')
    expect(error).not.toHaveProperty('cause')
  })

  it('bounds the storage request and preserves the raw File at the Axios boundary', async () => {
    const adapter: AxiosAdapter = vi.fn(async (config) => {
      expect(config.data).toBe(file)
      expect(config.timeout).toBe(120_000)
      expect(config.url).toBe(authorization.url)

      return apiResponse(config, '')
    })

    const originalAdapter = storageHttp.defaults.adapter

    try {
      storageHttp.defaults.adapter = adapter

      await uploadFileToStorage(file, authorization, {
        signal: new AbortController().signal,
      })
    } finally {
      storageHttp.defaults.adapter = originalAdapter
    }

    expect(adapter).toHaveBeenCalledOnce()
  })

  it('normalizes timeout errors for both request phases', async () => {
    const timeout: AxiosAdapter = (config) => Promise.reject(new AxiosError(
      authorization.url,
      'ETIMEDOUT',
      config,
    ))

    const originalAdapter = storageHttp.defaults.adapter

    apiHttp.defaults.adapter = timeout
    storageHttp.defaults.adapter = timeout

    try {
      const options = { signal: new AbortController().signal }

      await expect(requestUploadAuthorization({
        filename: file.name,
        size: file.size,
        contentType: file.type,
      }, options)).rejects.toMatchObject({
        code: 'timeout',
        message: 'Upload request timed out. Try again.',
      })

      await expect(uploadFileToStorage(file, authorization, options)).rejects.toMatchObject({
        code: 'timeout',
        message: 'Upload request timed out. Try again.',
      })
    } finally {
      storageHttp.defaults.adapter = originalAdapter
    }
  })
})
