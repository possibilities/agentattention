import type { CredentialConfig } from "./config.ts";
import type { Principal } from "./domain.ts";
import { forbidden, unauthorized } from "./errors.ts";
import { hashToken } from "./ids.ts";

export class Authenticator {
  private readonly credentials: Map<string, CredentialConfig>;

  constructor(credentials: CredentialConfig[]) {
    this.credentials = new Map(credentials.map((credential) => [credential.tokenHash, credential]));
  }

  authenticate(request: Request, requiredScope: string): Principal {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw unauthorized();
    const token = authorization.slice("Bearer ".length);
    if (!token.startsWith("aat_") || token.length > 200) throw unauthorized();
    const credential = this.credentials.get(hashToken(token));
    if (!credential) throw unauthorized();
    if (!credential.scopes.includes("admin") && !credential.scopes.includes(requiredScope)) {
      throw forbidden();
    }
    return { id: credential.id, name: credential.name, scopes: [...credential.scopes] };
  }
}
