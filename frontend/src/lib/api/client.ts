const BASE_URL = process.env.BACKEND_API_URL ?? "http://localhost:3000";

export interface Paginated<T> {
  page: number;
  pageSize: number;
  totalCount: number;
  data: T[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | undefined>;

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
}

async function request<T>(path: string, query?: Query): Promise<T & { status: string; message?: string }> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), { cache: "no-store" });
  } catch {
    throw new ApiError(`Backend unreachable at ${BASE_URL}`);
  }
  if (!res.ok) throw new ApiError(`GET ${path} failed with ${res.status}`, res.status);

  const body = (await res.json()) as T & { status: string; message?: string };
  if (body.status !== "success") {
    throw new ApiError(body.message || `GET ${path} returned an unexpected response`);
  }
  return body;
}

/** For `{ status, data }` responses. */
export async function apiGet<T>(path: string, query?: Query): Promise<T> {
  const body = await request<{ data: T }>(path, query);
  if (!("data" in body)) throw new ApiError(`GET ${path} returned no data`);
  return body.data;
}

/** For `{ status, page, pageSize, totalCount, data }` responses. */
export async function apiGetPage<T>(path: string, query?: Query): Promise<Paginated<T>> {
  const { page, pageSize, totalCount, data } = await request<Paginated<T>>(path, query);
  return { page, pageSize, totalCount, data };
}
