/**
 * Adds a member to a company under the invitation rules (owner decisions):
 *  - a NEW email gets a generated temporary password (mustChangePassword); the
 *    member replaces it at first sign-in, then signs in with the chosen password;
 *  - an EXISTING user gets an INVITED membership and accepts it with their own
 *    password (POST /me/invitations/:membershipId/accept).
 * Used by the e2e specs so they all follow the same flow.
 */
import request from 'supertest';

export interface AddMemberOptions {
  email: string;
  roleCode: string;
  /** The member's own password: chosen at change-password (new user) or already theirs (existing user). */
  password: string;
  fullName?: string;
  branchIds?: string[];
  defaultBranchId?: string;
  /** Company to sign in to at the end, for a member who belongs to several. */
  tenantId?: string;
}

export interface AddedMember {
  membershipId: string;
  /** Access token scoped to the inviting company (or opts.tenantId). */
  token: string;
  /** The invite response body (includes temporaryPassword for a new user). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the raw response body, asserted by each spec
  invite: any;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function signIn(
  base: string,
  email: string,
  password: string,
  tenantId?: string,
): Promise<{ status: number; accessToken: string; body: { accessToken?: string } }> {
  const res = await request(base)
    .post('/api/v1/auth/login')
    .send({ email, password, ...(tenantId ? { tenantId } : {}) });
  return { status: res.status, accessToken: res.body.accessToken, body: res.body };
}

async function tokenOf(
  base: string,
  email: string,
  password: string,
  tenantId?: string,
): Promise<string> {
  const res = await signIn(base, email, password, tenantId);
  if (res.status !== 200) {
    throw new Error(`sign-in for ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.accessToken;
}

export async function addMember(
  base: string,
  ownerToken: string,
  opts: AddMemberOptions,
): Promise<AddedMember> {
  const invited = await request(base)
    .post('/api/v1/users/invite')
    .set(bearer(ownerToken))
    .send({
      email: opts.email,
      roleCode: opts.roleCode,
      ...(opts.fullName !== undefined ? { fullName: opts.fullName } : {}),
      ...(opts.branchIds !== undefined ? { branchIds: opts.branchIds } : {}),
      ...(opts.defaultBranchId !== undefined ? { defaultBranchId: opts.defaultBranchId } : {}),
    });
  if (invited.status !== 201) {
    throw new Error(`invite of ${opts.email} failed: ${invited.status} ${JSON.stringify(invited.body)}`);
  }
  const invite = invited.body;
  const membershipId: string = invite.membershipId;

  if (typeof invite.temporaryPassword === 'string') {
    // New account: replace the temporary password, then sign in with the chosen one.
    const temporary = invite.temporaryPassword as string;
    const first = await signIn(base, opts.email, temporary);
    if (first.status !== 200 || !first.accessToken) {
      throw new Error(`first sign-in of ${opts.email} failed: ${first.status}`);
    }
    const changed = await request(base)
      .post('/api/v1/auth/change-password')
      .set(bearer(first.accessToken))
      .send({ currentPassword: temporary, newPassword: opts.password });
    if (changed.status !== 204) {
      throw new Error(`change-password of ${opts.email} failed: ${changed.status} ${JSON.stringify(changed.body)}`);
    }
    const token = await tokenOf(base, opts.email, opts.password, opts.tenantId);
    return { membershipId, token, invite };
  }

  // Existing user: the invitation waits in their inbox until they accept it.
  const own = await tokenOf(base, opts.email, opts.password);
  const accepted = await request(base)
    .post(`/api/v1/me/invitations/${membershipId}/accept`)
    .set(bearer(own));
  if (accepted.status !== 200) {
    throw new Error(`accept of ${opts.email} failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  const token = await tokenOf(base, opts.email, opts.password, accepted.body.tenantId as string);
  return { membershipId, token, invite };
}
