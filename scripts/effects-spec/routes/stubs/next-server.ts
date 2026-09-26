// Stub of next/server: only what the routes touch.
export class NextRequest {
  readonly nextUrl: URL;
  private readonly bodyText: string | undefined;
  constructor(url: string, init: { method?: string; body?: string } = {}) {
    this.nextUrl = new URL(url);
    this.bodyText = init.body;
  }
  async json(): Promise<unknown> {
    if (this.bodyText === undefined) throw new SyntaxError("Unexpected end of JSON input");
    return JSON.parse(this.bodyText);
  }
  async text(): Promise<string> {
    return this.bodyText ?? "";
  }
}
export class NextResponse {
  constructor(readonly status: number, private readonly payload: unknown) {}
  static json(body: unknown, init?: { status?: number }): NextResponse {
    // what goes over the wire: JSON, nothing else
    return new NextResponse(init?.status ?? 200, JSON.parse(JSON.stringify(body)));
  }
  async json(): Promise<any> {
    return this.payload;
  }
}
