/**
 * Typed application error hierarchy.
 * All errors thrown within route handlers should extend AppError so
 * the Fastify error handler can map them to correct HTTP status codes.
 */

export class AppError extends Error {
    readonly statusCode: number
    readonly code: string

    constructor(message: string, statusCode: number, code: string) {
        super(message)
        this.name = 'AppError'
        this.statusCode = statusCode
        this.code = code
    }
}

export class NotFoundError extends AppError {
    constructor(resource: string) {
        super(`${resource} not found`, 404, 'NOT_FOUND')
    }
}

export class UnauthorizedError extends AppError {
    constructor(detail?: string) {
        super(detail ?? 'Unauthorized', 401, 'UNAUTHORIZED')
    }
}

export class ValidationError extends AppError {
    constructor(detail: string) {
        super(detail, 422, 'VALIDATION_ERROR')
    }
}

export class ConflictError extends AppError {
    constructor(detail: string) {
        super(detail, 409, 'CONFLICT')
    }
}

export class RateLimitError extends AppError {
    constructor() {
        super('Rate limit exceeded', 429, 'RATE_LIMIT')
    }
}

/** Attach this as the Fastify setErrorHandler callback. */
export function errorHandler(
    error: Error & { statusCode?: number; code?: string; issues?: unknown[] },
    _request: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
): void {
    if (error instanceof AppError) {
        reply.code(error.statusCode).send({
            error: error.code,
            message: error.message,
        })
        return
    }

    // Fastify body-parser errors (payload too large, malformed JSON, etc.)
    if (error.statusCode && error.statusCode < 500) {
        reply.code(error.statusCode).send({
            error: error.code ?? 'BAD_REQUEST',
            message: error.message,
        })
        return
    }

    // Zod validation errors
    if (error.name === 'ZodError' && error.issues) {
        reply.code(422).send({
            error: 'VALIDATION_ERROR',
            message: error.message,
        })
        return
    }

    // Unexpected error — return 500
    // eslint-disable-next-line no-console
    console.error(error)
    reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
}
