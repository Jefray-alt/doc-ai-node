import axios, { Axios } from 'axios'

export const apiHttp = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15_000,
})

// Construct independently of Axios global/API defaults. Storage is cross-origin
// (Moto or S3); XHR supports upload progress without streaming-fetch requirements.
export const storageHttp = new Axios({
  adapter: 'xhr',
  timeout: 120_000,
  withCredentials: false,
  withXSRFToken: false,

  headers: {
    Accept: false,
    'Content-Type': false,
    'User-Agent': false,
  },

  transformRequest: [(data) => data],
  transformResponse: [(data) => data],

  validateStatus: (status) => status >= 200 && status < 300,
})
