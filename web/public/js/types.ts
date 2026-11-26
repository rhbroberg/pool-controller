// Shared shapes the status store and API client share.

export type UserRole = 'viewer' | 'user' | 'admin';

/** what's kept of a sign-in after login or ticket exchange */
export interface Credentials {
    email: string;
    token: string;
    role: UserRole | string | null;
    methods?: string[] | null;
}

export interface SignInResult {
    email: string;
    token: string;
    role?: UserRole | string;
    methods?: string[];
    mustChangeCredentials?: boolean;
}

/** one switch or sensor reading as GET /status and live updates send it */
export interface Reading {
    name: string;
    category: string;
    value: number;
    timestamp: Date | null;
    message?: string;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
