export interface HttpRequest {
  headers?: Readonly<Record<string, string>>;
  body: BodyInit;
  timeoutMs: number;
}

export interface HttpGetRequest {
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpClient {
  post(url: string, request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpGetClient {
  get(url: string, request: HttpGetRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient, HttpGetClient {
  async get(url: string, request: HttpGetRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const init: RequestInit = { method: "GET", signal: controller.signal };
      if (request.headers !== undefined) init.headers = request.headers;
      const response = await fetch(url, init);
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async post(url: string, request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const init: RequestInit = {
        method: "POST",
        body: request.body,
        signal: controller.signal,
      };
      if (request.headers !== undefined) init.headers = request.headers;
      const response = await fetch(url, init);
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}
