import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsServiceManager } from 'nestjs-cls';
import { JOFOTARA_PRODUCTION_URL } from 'jofotara-kit';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import type { Env } from '../../common/config/env.validation.js';
import { openSecret, sealSecret } from '../../common/crypto/secret-box.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { LOOPBACK_HOSTS } from '../../common/net/loopback.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { UpdateEInvoiceSettingsDto } from './dto/einvoice.dto.js';

/** Where SANDBOX sends by default: the local mock (`npx jofotara-kit serve --port 8080`). */
export const DEFAULT_SANDBOX_URL = 'http://127.0.0.1:8080';

/**
 * PRODUCTION e-invoicing is allowed only on a production server, or when the
 * operator explicitly opts in. EINVOICE_ALLOW_PRODUCTION is read from
 * process.env because it is not in the config schema yet (platform session).
 */
export function productionAllowed(nodeEnv: string | undefined, allowFlag: string | undefined): boolean {
  return nodeEnv === 'production' || allowFlag === 'true';
}

type SettingsRow = {
  environment: 'SANDBOX' | 'PRODUCTION';
  baseUrl: string | null;
  clientId: string | null;
  secretEncrypted: string | null;
  incomeSourceSequence: string | null;
  track: 'INCOME' | 'GENERAL_SALES';
  nextIcv: number;
  isEnabled: boolean;
  enabledAt: Date | null;
};

/**
 * JoFotara connection settings per company (BUILD_PLAN §12.3, 0005 §13).
 * The Secret-Key is sealed with AES-256-GCM before it is stored and is never
 * returned, logged or audited — the API only says whether one is set.
 */
@Injectable()
export class EInvoiceSettingsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private view(s: SettingsRow | null, company: { taxNumber: string | null; legalNameAr: string } | null) {
    return {
      sellerTaxNumber: company?.taxNumber ?? null,
      sellerName: company?.legalNameAr ?? null,
      environment: s?.environment ?? 'SANDBOX',
      baseUrl: s?.baseUrl ?? null,
      defaultSandboxUrl: DEFAULT_SANDBOX_URL,
      clientId: s?.clientId ?? null,
      hasSecret: Boolean(s?.secretEncrypted),
      incomeSourceSequence: s?.incomeSourceSequence ?? null,
      track: s?.track ?? 'GENERAL_SALES',
      nextIcv: s?.nextIcv ?? 1,
      isEnabled: s?.isEnabled ?? false,
      enabledAt: s?.enabledAt ?? null,
      encryptionKeySet: this.encryptionKey() !== undefined,
    };
  }

  private encryptionKey(): string | undefined {
    return this.config.get('EINVOICE_ENC_KEY', { infer: true }) || undefined;
  }

  private seller(db: ReturnType<DocumentSupportService['tenant']>['db'], companyId: bigint) {
    return db.company.findFirst({ where: { id: companyId }, select: { taxNumber: true, legalNameAr: true } });
  }

  async get() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const [s, company] = await Promise.all([
      db.eInvoiceSettings.findFirst({ where: { companyId } }),
      this.seller(db, companyId),
    ]);
    return this.view(s, company);
  }

  async update(dto: UpdateEInvoiceSettingsDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    const existing = await db.eInvoiceSettings.findFirst({ where: { companyId } });

    // Production sends real tax records: only on a production server (or with the explicit flag).
    if (
      dto.environment === 'PRODUCTION' &&
      !productionAllowed(this.config.get('NODE_ENV', { infer: true }), process.env.EINVOICE_ALLOW_PRODUCTION)
    ) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        'PRODUCTION e-invoicing is only allowed on a production server (NODE_ENV=production) or with EINVOICE_ALLOW_PRODUCTION=true',
      );
    }
    // Production sends real tax records: the owner's call only (BUILD_PLAN §12.3).
    if (dto.environment === 'PRODUCTION' && existing?.environment !== 'PRODUCTION') {
      const role = ClsServiceManager.getClsService<RequestContext>().get('roleCode');
      if (role !== 'OWNER') {
        throw new DomainError(ErrorCode.FORBIDDEN, 'Only the owner can switch e-invoicing to production');
      }
    }

    const baseUrl =
      dto.environment === 'SANDBOX'
        ? normalizeSandboxUrl(
            dto.baseUrl,
            this.config.get('EINVOICE_SANDBOX_HOSTS', { infer: true }),
            this.config.get('NODE_ENV', { infer: true }),
          )
        : null;
    // The stored secret belongs to the server it was entered for: a change of
    // environment or sandbox URL drops it unless a new one comes with it, so a
    // production Secret-Key can never be sent to another host (BUILD_PLAN §12.3).
    const target = (env: string, url: string | null) => `${env}|${url ?? ''}`;
    const sameTarget = existing ? target(existing.environment, existing.baseUrl) === target(dto.environment, baseUrl) : true;
    let secretEncrypted = sameTarget ? (existing?.secretEncrypted ?? null) : null;
    if (dto.secretKey) {
      const key = this.encryptionKey();
      if (!key) {
        throw new DomainError(ErrorCode.EINVOICE_NOT_READY, 'EINVOICE_ENC_KEY is not set on the server');
      }
      try {
        secretEncrypted = sealSecret(dto.secretKey.trim(), key);
      } catch {
        throw new DomainError(ErrorCode.EINVOICE_NOT_READY, 'EINVOICE_ENC_KEY must be 32 bytes, base64');
      }
    }
    const clientId = dto.clientId?.trim() || null;
    const incomeSourceSequence = dto.incomeSourceSequence?.trim() || null;

    // The seller as JoFotara knows it lives on the company (0005 §4).
    if (dto.sellerTaxNumber !== undefined || dto.sellerName !== undefined) {
      await db.company.update({
        where: { id: companyId },
        data: {
          ...(dto.sellerTaxNumber !== undefined ? { taxNumber: dto.sellerTaxNumber } : {}),
          ...(dto.sellerName !== undefined ? { legalNameAr: dto.sellerName.trim() } : {}),
        },
      });
    }

    if (dto.isEnabled) {
      const company = await db.company.findFirst({
        where: { id: companyId },
        select: { taxNumber: true, baseCurrency: { select: { code: true } } },
      });
      const missing = [
        !company?.taxNumber || !/^\d+$/.test(company.taxNumber) ? 'the company tax number (digits)' : null,
        company?.baseCurrency && company.baseCurrency.code !== 'JOD' ? 'JOD as the base currency' : null,
        !clientId ? 'Client-Id' : null,
        !secretEncrypted ? 'Secret-Key' : null,
        !incomeSourceSequence ? 'the income source sequence' : null,
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new DomainError(ErrorCode.EINVOICE_NOT_READY, `E-invoicing needs ${missing.join(', ')}`, {
          missing,
        });
      }
    }

    const data = {
      environment: dto.environment,
      baseUrl,
      clientId,
      secretEncrypted,
      incomeSourceSequence,
      track: dto.track,
      isEnabled: dto.isEnabled,
      enabledAt: dto.isEnabled ? (existing?.isEnabled ? existing.enabledAt : new Date()) : (existing?.enabledAt ?? null),
      updatedBy: userId ?? null,
    };
    const saved = existing
      ? await db.eInvoiceSettings.update({ where: { id: existing.id }, data })
      : await db.eInvoiceSettings.create({ data: { ...data, tenantId, companyId, createdBy: userId ?? null } });

    // Never the secret, only whether it changed.
    await this.audit.log({
      action: 'einvoice.settings.update',
      entityType: 'einvoice_settings',
      entityId: saved.id,
      after: {
        environment: saved.environment,
        track: saved.track,
        isEnabled: saved.isEnabled,
        clientIdSet: Boolean(saved.clientId),
        secretChanged: Boolean(dto.secretKey),
        sellerChanged: dto.sellerTaxNumber !== undefined || dto.sellerName !== undefined,
      },
    });
    return this.view(saved, await this.seller(db, companyId));
  }

  /**
   * What the sender needs to reach JoFotara for one company. Stays inside
   * the server: the opened secret is never stored, logged or returned.
   */
  async connection(companyId: bigint) {
    const { db } = this.support.tenant();
    const s = await db.eInvoiceSettings.findFirst({ where: { companyId } });
    // Disabling e-invoicing stops the queue: the sender turns this into FAILED, not a send.
    if (s && !s.isEnabled) {
      throw new DomainError(ErrorCode.EINVOICE_NOT_READY, 'E-invoicing is disabled for this company');
    }
    if (!s?.clientId || !s.secretEncrypted) return null;
    // Re-checked at send time: a stored PRODUCTION setting must not reach the production host on a server that does not allow it.
    if (
      s.environment === 'PRODUCTION' &&
      !productionAllowed(this.config.get('NODE_ENV', { infer: true }), process.env.EINVOICE_ALLOW_PRODUCTION)
    ) {
      throw new DomainError(
        ErrorCode.EINVOICE_NOT_READY,
        'PRODUCTION e-invoicing is only allowed on a production server (NODE_ENV=production) or with EINVOICE_ALLOW_PRODUCTION=true',
      );
    }
    const key = this.encryptionKey();
    if (!key) return null;
    let secretKey: string;
    try {
      secretKey = openSecret(s.secretEncrypted, key);
    } catch {
      return null;
    }
    return {
      environment: s.environment,
      baseUrl: s.environment === 'PRODUCTION' ? JOFOTARA_PRODUCTION_URL : (s.baseUrl ?? DEFAULT_SANDBOX_URL),
      clientId: s.clientId,
      secretKey,
      track: s.track,
      incomeSourceSequence: s.incomeSourceSequence ?? '',
    };
  }
}

/**
 * A SANDBOX URL must be http(s), must not be the production host (any port)
 * and must be this machine — or a host the operator listed in
 * EINVOICE_SANDBOX_HOSTS (comma-separated), e.g. a shared mock. So the
 * server never posts to an arbitrary address chosen in the settings screen.
 * In production, loopback is accepted only when listed too (hostname or hostname:port).
 */
function normalizeSandboxUrl(
  raw: string | null | undefined,
  allowed: string | undefined,
  nodeEnv: string | undefined,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError(ErrorCode.VALIDATION, 'The sandbox URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DomainError(ErrorCode.VALIDATION, 'The sandbox URL must start with http:// or https://');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === new URL(JOFOTARA_PRODUCTION_URL).hostname) {
    throw new DomainError(ErrorCode.VALIDATION, 'The sandbox must not point at the production JoFotara server');
  }
  const extra = new Set((allowed ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
  const hostPort = url.port ? `${host}:${url.port}` : host;
  const listed = extra.has(host) || extra.has(hostPort);
  const loopbackOk = LOOPBACK_HOSTS.has(host) && (nodeEnv !== 'production' || listed);
  if (!loopbackOk && !listed) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      'The sandbox URL must be on this server (127.0.0.1 / localhost) or listed in EINVOICE_SANDBOX_HOSTS',
    );
  }
  return value.replace(/\/+$/, '');
}
