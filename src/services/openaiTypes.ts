// Shared types and helpers for the OpenAI Responses API (POST /v1/responses).
// Both the extraction service and the template builder use this API.

export interface ResponsesApiContentPart {
  type: string;
  text?: string;
}

export interface ResponsesApiOutputItem {
  type: string;
  content?: ResponsesApiContentPart[];
}

export interface ResponsesApiResponse {
  output?: ResponsesApiOutputItem[];
  /** SDK convenience property — not present in raw HTTP JSON. */
  output_text?: string;
}

/** Walk the Responses API output array to find the assistant's output_text. */
export function extractOutputText(data: ResponsesApiResponse): string {
  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          return part.text;
        }
      }
    }
  }
  return data.output_text ?? '';
}
