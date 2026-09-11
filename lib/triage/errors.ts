import { NextResponse } from "next/server";

import type { ErrorResponse } from "@/types/contract";

/**
 * 构造契约约定的错误响应：{ error: { code, message, field? }, requestId }
 * 错误码取值见 types/contract.ts 中 ErrorResponse 的注释。
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  field?: string,
): NextResponse<ErrorResponse> {
  return NextResponse.json(
    {
      error: field === undefined ? { code, message } : { code, message, field },
      requestId,
    },
    { status },
  );
}
