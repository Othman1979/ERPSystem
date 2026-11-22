import { TenantMirrorService } from './tenant-mirror.service.js';

describe('TenantMirrorService', () => {
  it("stores the password hash sentinel when syncing a user", async () => {
    const user = {
      id: 4n,
      email: 'owner@example.test',
      fullName: 'Owner',
      locale: 'ar',
      isActive: true,
      isPlatformAdmin: false,
      lastLoginAt: null,
      mustChangePassword: false,
      passwordChangedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let upsertArgs: unknown;
    const service = new TenantMirrorService({
      control: () => ({ user: { findUnique: async () => user } }),
    } as never);

    await service.syncUser({
      user: { upsert: async (args: unknown) => { upsertArgs = args; } },
    } as never, user.id);

    expect(upsertArgs).toEqual({
      where: { id: user.id },
      create: { ...user, passwordHash: '!' },
      update: { ...user, passwordHash: '!' },
    });
  });
});
