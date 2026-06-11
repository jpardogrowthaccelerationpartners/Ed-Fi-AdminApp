import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  determineTenantModeFromMetadata,
  fetchOdsApiMetadata,
  validateAdminApiUrl,
  validateTenantModeCompatibility,
  ValidationHttpException,
} from '../utils';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { addUserCreating, EdfiTenant, SbEnvironment, Edorg, Ods, SbSyncQueue } from '@edanalytics/models-server';
import { EntityManager, Repository } from 'typeorm';
import {
  StartingBlocksServiceV1,
  StartingBlocksServiceV2,
} from '../teams/edfi-tenants/starting-blocks';
import {
  PostSbEnvironmentDto,
  PutSbEnvironmentDto,
  SbV1MetaOds,
  EdorgType,
  SbV2MetaEnv,
  SbV2MetaOds,
  PostSbEnvironmentTenantDTO,
  GetUserDto,
  ISbEnvironmentConfigPublicV2,
  toSbSyncQueueDto,
} from '@edanalytics/models';
import axios from 'axios';
import { persistSyncTenant, SyncableOds } from '../sb-sync/sync-ods';
import { randomBytes, randomUUID } from 'crypto';
import { ENV_SYNC_CHNL } from '../sb-sync/sb-sync.module';
import { IJobQueueService } from '../sb-sync/job-queue/job-queue.interface';

type TenantCredentials = { clientId: string; clientSecret: string; displayName: string };

@Injectable()
export class SbEnvironmentsEdFiService {
  private readonly logger = new Logger(SbEnvironmentsEdFiService.name);

  constructor(
    @InjectRepository(SbEnvironment)
    private sbEnvironmentsRepository: Repository<SbEnvironment>,
    private readonly startingBlocksServiceV1: StartingBlocksServiceV1,
    private readonly startingBlocksServiceV2: StartingBlocksServiceV2,
    @InjectRepository(EdfiTenant)
    private edfiTenantsRepository: Repository<EdfiTenant>,
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
    @Inject('IJobQueueService')
    private readonly jobQueue: IJobQueueService,
    @InjectRepository(SbSyncQueue)
    private readonly queueRepository: Repository<SbSyncQueue>
  ) {}

  private errorMessageEnhancer(originalMessage: string): string {
    // Define error patterns and their enhanced messages
    const errorPatterns = [
      // HTTP status codes
      { pattern: '404', message: 'Service not found (404)' },
      { pattern: '401', message: 'Unauthorized (401) - check API credentials' },
      { pattern: '403', message: 'Forbidden (403) - insufficient permissions' },
      { pattern: '400', message: 'Bad request (400) - invalid request format' },
      { pattern: '500', message: 'Internal server error (500) - service may be down' },
      { pattern: '502', message: 'Bad gateway (502) - service may be unreachable' },
      { pattern: '503', message: 'Service unavailable (503) - service may be temporarily down' },
      // Network error codes
      { pattern: 'ECONNREFUSED', message: 'Connection refused - service may not be running' },
      { pattern: 'ENOTFOUND', message: 'Host not found - check the URL' },
      { pattern: 'certificate', message: 'SSL certificate error - check certificate configuration' },
      { pattern: 'ECONNRESET', message: 'Connection reset - service may have closed the connection' },
      { pattern: 'timeout', message: 'Request timeout - service may be slow to respond' },
    ];

    // Find the first matching pattern
    const matchedPattern = errorPatterns.find(({ pattern }) =>
      originalMessage.includes(pattern)
    );

    // Return enhanced message or original if no pattern matches
    return matchedPattern ? matchedPattern.message : originalMessage;
  }

  private handleOperationError(error: unknown, detectedVersion: string): never {

    if (error instanceof ValidationHttpException) {
      // Extract the current field and message from the ValidationHttpException
      const response = error.getResponse() as {
        field?: string;
        message?: string;
        data?: {
          errors?: Record<string, { message?: string; type?: string }>;
        }
      };
      let originalField = 'general';
      let originalMessage = 'Validation error occurred';

      // First try to get field and message from the top level
      if (response?.field) {
        originalField = response.field;
      }
      if (response?.message) {
        originalMessage = response.message;
      }

      // If not found, check the nested data.errors structure
      if (response?.data?.errors) {
        const firstErrorKey = Object.keys(response.data.errors)[0];
        if (firstErrorKey) {
          originalField = firstErrorKey; // Use the field name from errors object
          const errorDetails = response.data.errors[firstErrorKey];
          if (errorDetails?.message) {
            originalMessage = errorDetails.message;
          }
        }
      }

      // Use the common error message enhancer
      const enhancedMessage = this.errorMessageEnhancer(originalMessage);

      // Re-throw with enhanced message but preserve the original field
      throw new ValidationHttpException({
        field: originalField,
        message: enhancedMessage,
      });
    }

    let message: string;

    if (error instanceof Error) {
      // Use the common error message enhancer
      message = this.errorMessageEnhancer(error.message);
    } else {
      message = 'Unknown error occurred';
    }

    // Enhanced error logging
    this.logger.error('Create environment error details:', {
      error: message,
      code: (error as NodeJS.ErrnoException)?.code, // Node.js specific error codes
      cause: (error as { cause?: unknown })?.cause,
    });

    // Create new InternalServerErrorException
    throw new InternalServerErrorException(
      `Error while creating the ${detectedVersion} environment`
    );
  }

  async create(createSbEnvironmentDto: PostSbEnvironmentDto, user: GetUserDto | undefined) {
    // First validate the Admin API URL before proceeding with any operations
    // validateAdminApiUrl returns the fetched Admin API metadata to avoid duplicate network calls
    let adminApiInfo;
    if (createSbEnvironmentDto.adminApiUrl) {
      adminApiInfo = await validateAdminApiUrl(createSbEnvironmentDto.adminApiUrl, createSbEnvironmentDto.odsApiDiscoveryUrl);
    }

    // Validate ODS Discovery URL if provided
    if (createSbEnvironmentDto.odsApiDiscoveryUrl) {
      try {
        // Declare variables in the outer scope so they can be used later
        let odsApiMetaResponse;
        let detectedVersion;
        let tenantMode;

        // Nested try-catch for ODS API metadata operations
        try {
          // Fetch ODS API metadata
          odsApiMetaResponse = await fetchOdsApiMetadata(createSbEnvironmentDto);

          if (!adminApiInfo?.specificationVersion) {
            throw new ValidationHttpException({
              field: 'adminApiUrl',
              message: 'Management API Discovery URL is required to determine API version.',
            });
          }

          detectedVersion = adminApiInfo.specificationVersion;

          // Override the version with detected version
          createSbEnvironmentDto.version = detectedVersion;

          // Determine tenant mode - pass both ODS and Admin API info, function prioritizes Admin API field
          tenantMode = determineTenantModeFromMetadata(odsApiMetaResponse, adminApiInfo);
          createSbEnvironmentDto.isMultitenant = tenantMode === 'MultiTenant';

          // Validate tenant mode compatibility if both APIs are available
          if (adminApiInfo) {
            // Only validate if Admin API explicitly defines multitenantMode
            if (adminApiInfo?.tenancy?.multitenantMode !== undefined) {
              const odsTenantMode = determineTenantModeFromMetadata(odsApiMetaResponse);
              const adminTenantMode = adminApiInfo.tenancy.multitenantMode ? 'MultiTenant' : 'SingleTenant';
              validateTenantModeCompatibility(odsTenantMode, adminTenantMode);
            } else {
              this.logger.log('Admin API does not provide multitenantMode field, skipping tenant mode compatibility check');
            }
          }

        } catch (metadataError) {
          // Re-throw validation exceptions without wrapping (e.g., tenant mode compatibility errors)
          if (metadataError instanceof ValidationHttpException) {
            throw metadataError;
          }

          // Handle ODS Discovery URL specific errors
          this.logger.error('ODS metadata fetch error:', metadataError);

          throw new ValidationHttpException({
            field: 'odsApiDiscoveryUrl',
            message: metadataError.message,
          });
        }


        // Build configPublic based on detected version
        const configPublic =
          createSbEnvironmentDto.version === 'v1'
            ? {
                startingBlocks: createSbEnvironmentDto.startingBlocks,
                odsApiMeta: odsApiMetaResponse,
                adminApiUrl: createSbEnvironmentDto.adminApiUrl,
                version: createSbEnvironmentDto.version,
                values: {
                  edfiHostname: createSbEnvironmentDto.odsApiDiscoveryUrl,
                  adminApiUrl: createSbEnvironmentDto.adminApiUrl,
                },
              }
            : {
                startingBlocks: createSbEnvironmentDto.startingBlocks,
                odsApiMeta: odsApiMetaResponse,
                adminApiUrl: createSbEnvironmentDto.adminApiUrl,
                version: createSbEnvironmentDto.version,
                values: {
                  meta: {
                    envlabel: createSbEnvironmentDto.environmentLabel,
                    mode: tenantMode,
                    domainName: createSbEnvironmentDto.odsApiDiscoveryUrl,
                    adminApiUrl: createSbEnvironmentDto.adminApiUrl,
                    tenantManagementFunctionArn: '',
                    tenantResourceTreeFunctionArn: '',
                    odsManagementFunctionArn: '',
                    edorgManagementFunctionArn: '',
                    dataFreshnessFunctionArn: '',
                  } satisfies SbV2MetaEnv,
                  adminApiUuid: randomUUID(),
                },
              };
        Logger.log(
          `Auto-detected API version: ${detectedVersion} from ODS version: ${odsApiMetaResponse.version}`
        );
        const sbEnvironment = await this.sbEnvironmentsRepository.save(
          addUserCreating(
            this.sbEnvironmentsRepository.create({
              name: createSbEnvironmentDto.name,
              envLabel: createSbEnvironmentDto.environmentLabel, //this field is for the lambda function
              configPublic: configPublic,
            } as SbEnvironment),
            user
          )
        );
        if (createSbEnvironmentDto.version === 'v1') {
          await this.syncv1Environment(sbEnvironment, createSbEnvironmentDto);
          return sbEnvironment;
        } else if (createSbEnvironmentDto.version === 'v2') {
          const syncQueueItem = await this.syncv2Environment(sbEnvironment);
          return { ...sbEnvironment, syncQueue: toSbSyncQueueDto(syncQueueItem) };
        }

        return sbEnvironment;
      } catch (error) {
        this.handleOperationError(error, createSbEnvironmentDto.version);
      }
    }
  }

  private async syncv1Environment(
    sbEnvironment: SbEnvironment,
    createSbEnvironmentDto: PostSbEnvironmentDto
  ) {
    // For v1, use the first tenant from the frontend data
    if (!createSbEnvironmentDto.tenants || createSbEnvironmentDto.tenants.length === 0) {
      throw new ValidationHttpException({
        field: 'tenants',
        message: 'At least one tenant is required for v1 deployment',
      });
    }

    const defaultTenantDto = createSbEnvironmentDto.tenants[0];

    // Find or create the default tenant
    const edfiTenant = await this.findOrCreateTenant(sbEnvironment, defaultTenantDto.name);

    // Sync the tenant data using V1 method
    await this.syncTenantDataV1(defaultTenantDto, edfiTenant);

    // Make a POST request to register the client
    const { clientId, clientSecret } = await this.createClientCredentials(createSbEnvironmentDto);

    // Save the admin API credentials
    const credentials = {
      ClientId: clientId,
      ClientSecret: clientSecret,
      url: createSbEnvironmentDto.adminApiUrl,
    };
    await this.startingBlocksServiceV1.saveAdminApiCredentials(sbEnvironment, credentials);

    return { status: 'SUCCESS' as const };
  }

  private async syncv2Environment(sbEnvironment: SbEnvironment): Promise<SbSyncQueue> {
    const id = await this.jobQueue.send(
      ENV_SYNC_CHNL,
      { sbEnvironmentId: sbEnvironment.id },
      { expireInHours: 2 }
    );

    const pendingStates = new Set(['created', 'retry', 'active']);
    const maxAttempts = 20;
    const pollIntervalMs = 500;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      const queueItem = await this.queueRepository.findOneBy({ id });
      if (queueItem && !pendingStates.has(queueItem.state)) {
        return queueItem;
      }
    }

    // Timeout: return whatever state the job is in (or a synthetic item if still null)
    const queueItem = await this.queueRepository.findOneBy({ id });
    if (queueItem) return queueItem;

    // Fallback: job row never appeared in the tracking table
    const fallback = new SbSyncQueue();
    fallback.id = id;
    fallback.state = 'active';
    return fallback;
  }

  private async findOrCreateTenant(
    sbEnvironment: SbEnvironment,
    tenantName: string
  ): Promise<EdfiTenant> {
    const existingTenants = await this.edfiTenantsRepository.find({
      where: { sbEnvironmentId: sbEnvironment.id },
    });

    if (existingTenants.length === 0) {
      return await this.edfiTenantsRepository.save({
        name: tenantName,
        sbEnvironmentId: sbEnvironment.id,
      });
    }

    return existingTenants[0];
  }

  private async syncTenantDataV1(tenantDto: PostSbEnvironmentTenantDTO, tenantEntity: EdfiTenant) {
    // Create V1 ODS metadata objects
    const metaOds: SbV1MetaOds[] = this.createODSObjectV1(tenantDto);

    // Sync ODS and EdOrgs using V1 method
    await this.saveSyncableOdsV1(metaOds, tenantEntity);
  }

  private createODSObject(tenant: PostSbEnvironmentTenantDTO): SbV2MetaOds[] {
    return (
      tenant.odss?.map((ods) => ({
        id: ods.id, // the ID of the ODS instance, it has to be get it from adminapi/db
        name: ods.name, // The ODS name
        dbname: ods.dbName,
        edorgs: ods.allowedEdOrgs
          ?.split(',')
          .map((id) => id.trim())
          .filter((edorg) => edorg !== '' && !isNaN(Number(edorg)))
          .map((edorg) => ({
            educationorganizationid: parseInt(edorg),
            nameofinstitution: `Institution #${edorg}`,
            shortnameofinstitution: `I#${edorg}`,
            id: parseInt(edorg),
            discriminator: EdorgType['edfi.Other'],
            name: `Institution #${edorg}`,
          })),
      })) || []
    );
  }

  private createODSObjectV1(tenant: PostSbEnvironmentTenantDTO): SbV1MetaOds[] {
    return (
      tenant.odss?.map((ods) => ({
        id: ods.id,
        name: ods.name,
        dbname: ods.dbName,
        edorgs: ods.allowedEdOrgs
          ?.split(',')
          .map((id) => id.trim())
          .filter((edorg) => edorg !== '' && !isNaN(Number(edorg)))
          .map((edorg) => ({
            educationorganizationid: parseInt(edorg),
            nameofinstitution: `Institution #${edorg}`,
            shortnameofinstitution: `I#${edorg}`,
            id: parseInt(edorg),
            discriminator: EdorgType['edfi.Other'],
          })),
      })) || []
    );
  }

  private async saveSyncableOds(
    metaOds: SbV2MetaOds[],
    tenantEntity: { name: string; sbEnvironmentId: number } & EdfiTenant
  ) {
    const odss = (metaOds ?? []).map(
      (o): SyncableOds => ({
        ...o,
        dbName: o.dbname,
      })
    );
    // Store the data in the localDB
    await this.entityManager.transaction((em) =>
      persistSyncTenant({ em, odss, edfiTenant: tenantEntity })
    );
  }

  private async saveSyncableOdsV1(
    metaOds: SbV1MetaOds[],
    tenantEntity: { name: string; sbEnvironmentId: number } & EdfiTenant
  ) {
    const odss = (metaOds ?? []).map(
      (o): SyncableOds => ({
        id: o.id ?? null,
        name: o.name ?? o.dbname,
        dbName: o.dbname,
        edorgs: o.edorgs,
      })
    );
    // Store the data in the localDB
    await this.entityManager.transaction((em) =>
      persistSyncTenant({ em, odss, edfiTenant: tenantEntity })
    );
  }

  private async createClientCredentials(
    createSbEnvironmentDto: PostSbEnvironmentDto,
    tenant?: string
  ): Promise<TenantCredentials> {
    const registerUrl = `${createSbEnvironmentDto.adminApiUrl}/connect/register`;
    const secretCharset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    const secretBytes = randomBytes(32);
    const clientSecret = Array.from(secretBytes, (byte) => secretCharset[byte % secretCharset.length]).join('');
    const clientId = `client_${randomUUID()}`;
    const nameSuffixBytes = randomBytes(4);
    const displayNameSuffix = Array.from(nameSuffixBytes, (byte) =>
      (byte % 36).toString(36)
    ).join('');
    const displayName = `AdminApp-v4-${displayNameSuffix}`;
    const formData = new URLSearchParams();
    formData.append('ClientId', clientId);
    formData.append('ClientSecret', clientSecret);
    formData.append('DisplayName', displayName);

    const headers =
      createSbEnvironmentDto.isMultitenant && createSbEnvironmentDto.version === 'v2'
        ? {
            'Content-Type': 'application/x-www-form-urlencoded',
            tenant: tenant,
          }
        : {
            'Content-Type': 'application/x-www-form-urlencoded',
          };
    try {
      const registerResponse = await axios.post(registerUrl, formData.toString(), {
        headers: headers,
      });

      if (!registerResponse.status || registerResponse.status !== 200) {
        throw new Error(`Registration failed! status: ${registerResponse.status}`);
      }
      return { clientId, displayName, clientSecret };
    } catch (error) {
      this.logger.error('Failed to register client credentials:', error);

      // For multi-tenant v2 with tenant header, assume 400 errors are wrong tenant names
      if (createSbEnvironmentDto.isMultitenant && createSbEnvironmentDto.version === 'v2' && tenant && error.response?.status === 400) {
        throw new ValidationHttpException({
          field: 'tenants',
          message: `Tenant '${tenant}' does not exist or is not properly configured in the Admin API`,
        });
      }

      // For all other errors, treat as Admin API URL issues
      throw new ValidationHttpException({
        field: 'adminApiUrl',
        message: error.message,
      });
    }
  }

  /**
   * Update an existing environment with full configuration support
   * This method handles updating basic environment settings and tenant/ODS configuration
   */
  async updateEnvironment(id: number, updateDto: PutSbEnvironmentDto, user: GetUserDto | undefined) {
    try {
      // Find the existing environment
      const existingEnvironment = await this.sbEnvironmentsRepository.findOne({
        where: { id },
        relations: ['edfiTenants', 'edfiTenants.odss', 'edfiTenants.odss.edorgs'],
      });

      if (!existingEnvironment) {
        throw new ValidationHttpException({
          field: 'environment',
          message: 'Environment not found',
        });
      }

      // Validate API URLs only if they are being updated
      if (updateDto.adminApiUrl !== undefined) {
        await validateAdminApiUrl(updateDto.adminApiUrl, updateDto.odsApiDiscoveryUrl);
      }

      // Validate tenant credentials if we're updating URLs and the environment is v2 multi-tenant
      const isV2Environment = existingEnvironment.configPublic?.version === 'v2';
      const isV1Environment = existingEnvironment.configPublic?.version === 'v1';
      const hasUrlUpdates = updateDto.odsApiDiscoveryUrl || updateDto.adminApiUrl;
      const isCurrentlyMultiTenant = isV2Environment &&
        existingEnvironment.configPublic?.values &&
        'meta' in existingEnvironment.configPublic.values &&
        existingEnvironment.configPublic.values.meta?.mode === 'MultiTenant';

      // Validate that tenant mode changes are not attempted (security check)
      if (updateDto.isMultitenant !== undefined) {
        let expectedTenantMode: boolean;

        if (isV1Environment) {
          expectedTenantMode = false; // v1 is always single-tenant
        } else if (isV2Environment) {
          expectedTenantMode = isCurrentlyMultiTenant;
        } else {
          // Starting Blocks or unknown version - don't allow tenant mode changes
          expectedTenantMode = false;
        }

        if (updateDto.isMultitenant !== expectedTenantMode) {
          const currentMode = expectedTenantMode ? 'multi-tenant' : 'single-tenant';
          const attemptedMode = updateDto.isMultitenant ? 'multi-tenant' : 'single-tenant';
          const versionInfo = isV1Environment ? ' (v1 environments are always single-tenant)' :
                             isV2Environment ? '' : ' (tenant mode not applicable for this environment type)';
          throw new ValidationHttpException({
            field: 'isMultitenant',
            message: `Tenant mode cannot be changed after creation. Current mode: ${currentMode}, attempted: ${attemptedMode}${versionInfo}`,
          });
        }
      }

      // Handle credential recreation for v1 environments when Admin API URL changes
      if (hasUrlUpdates && updateDto.adminApiUrl && isV1Environment) {
        this.logger.log('Admin API URL changed for v1 environment - recreating credentials');

        const { clientId, clientSecret } = await this.createClientCredentials({
          adminApiUrl: updateDto.adminApiUrl,
          isMultitenant: false,
          version: 'v1'
        } as PostSbEnvironmentDto);

        const credentials = {
          ClientId: clientId,
          ClientSecret: clientSecret,
          url: updateDto.adminApiUrl,
        };

        await this.startingBlocksServiceV1.saveAdminApiCredentials(existingEnvironment, credentials);
        this.logger.log('V1 credentials recreated successfully');
      }

      // Update basic environment properties
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updatedProperties: any = {
        ...existingEnvironment,
        name: updateDto.name,
        modifiedById: user?.id,
        modified: new Date(),
      };

      // Update URL and configuration fields if provided
      if (updateDto.odsApiDiscoveryUrl !== undefined) {
        // Update the configPublic to store the new ODS API URL
        if (isV2Environment) {
          updatedProperties.configPublic = {
          ...existingEnvironment.configPublic,
          values: {
            ...existingEnvironment.configPublic?.values,
            ...(typeof existingEnvironment.configPublic?.values === 'object' &&
              'meta' in existingEnvironment.configPublic.values
              ? {
                  meta: {
                    ...((existingEnvironment.configPublic.values as ISbEnvironmentConfigPublicV2).meta),
                    domainName: updateDto.odsApiDiscoveryUrl.replace(/^https?:\/\//, ''),
                  },
                }
              : {}),
          },
        };
        }
        else{
        updatedProperties.configPublic = {
          ...existingEnvironment.configPublic,
          values: {
            ...existingEnvironment.configPublic?.values,
            edfiHostname: updateDto.odsApiDiscoveryUrl.replace(/^https?:\/\//, ''),
          },
        };
      }
      }

      if (updateDto.adminApiUrl !== undefined) {
        updatedProperties.configPublic = {
          ...updatedProperties.configPublic || existingEnvironment.configPublic,
          adminApiUrl: updateDto.adminApiUrl,
        };

        // When the Admin API URL changes on a v2 environment, the stored credentials
        // are invalid for the new endpoint. Clear them so the pg_boss job's bootstrap
        // logic re-registers fresh credentials against the new URL.
        const adminApiUrlChanged = updateDto.adminApiUrl !== existingEnvironment.adminApiUrl;
        if (isV2Environment && adminApiUrlChanged) {
          this.logger.log(
            `Admin API URL changed for v2 environment ${id} — clearing tenant credentials for re-bootstrap`
          );
          if (updatedProperties.configPublic?.values) {
            (updatedProperties.configPublic.values as ISbEnvironmentConfigPublicV2).tenants = {};
          }
          updatedProperties.configPrivate = { tenants: {} };
        }
      }

      if (updateDto.environmentLabel !== undefined) {
        updatedProperties.envLabel = updateDto.environmentLabel;
      }

      const updatedEnvironment = await this.sbEnvironmentsRepository.save(updatedProperties);
      let syncQueue;

      // For v2 environments, delegate tenant/ODS/EdOrg sync to the background job —
      // but only when fields that affect the sync result actually changed.
      // Name-only edits don't require a re-sync and would add unnecessary latency.
      const v2SyncTriggered = isV2Environment && hasUrlUpdates;
      if (v2SyncTriggered) {
        const syncQueueItem = await this.syncv2Environment(updatedEnvironment);
        syncQueue = toSbSyncQueueDto(syncQueueItem);
        this.logger.log(`Triggered v2 sync job for environment ID ${updatedEnvironment.id} after update`);
      } else if (updateDto.tenants && Array.isArray(updateDto.tenants)) {
        await this.updateEnvironmentTenants(updatedEnvironment, updateDto.tenants);
      }

      // Reload the environment with updated relations
      const reloadedEnvironment = await this.sbEnvironmentsRepository.findOne({
        where: { id },
        relations: ['edfiTenants', 'edfiTenants.odss', 'edfiTenants.odss.edorgs'],
      });

      if (!reloadedEnvironment) {
        throw new ValidationHttpException({
          field: 'environment',
          message: 'Environment not found after update',
        });
      }

      return { environment: reloadedEnvironment, syncQueue };
    } catch (error) {
      this.logger.error('Error updating environment:', error);
      throw error;
    }
  }

  /**
   * Update tenants and their ODS instances for an environment
   */
  private async updateEnvironmentTenants(
    sbEnvironment: SbEnvironment,
    tenantsData: PostSbEnvironmentTenantDTO[]
  ) {
    try {
      // Get existing tenants
      const existingTenants = await this.edfiTenantsRepository.find({
        where: { sbEnvironmentId: sbEnvironment.id },
        relations: ['odss', 'odss.edorgs'],
      });

      // Create a map of existing tenants by name for quick lookup
      const existingTenantsMap = new Map(
        existingTenants.map(tenant => [tenant.name, tenant])
      );

      // Track which tenants are being updated
      const updatedTenantNames = new Set(tenantsData.map(t => t.name));

      // Process each tenant in the update data
      for (const tenantData of tenantsData) {
        const existingTenant = existingTenantsMap.get(tenantData.name);

        if (existingTenant) {
          // Update existing tenant and its ODS instances
          await this.updateExistingTenant(existingTenant, tenantData, sbEnvironment);
          this.logger.log(`Updated existing tenant: ${tenantData.name}`);
        } else {
          // Create new tenant
          await this.createNewTenant(sbEnvironment, tenantData);
          this.logger.log(`Created new tenant: ${tenantData.name}`);
        }
      }

      // Remove tenants that are no longer in the update data
      for (const existingTenant of existingTenants) {
        if (!updatedTenantNames.has(existingTenant.name)) {
          await this.removeTenant(existingTenant);
          this.logger.log(`Removed tenant: ${existingTenant.name}`);
        }
      }

      this.logger.log('Tenant synchronization completed');
    } catch (error) {
      this.logger.error('Error updating environment tenants:', error);
      throw error;
    }
  }

  /**
   * Update an existing tenant and its ODS instances
   */
  private async updateExistingTenant(
    existingTenant: EdfiTenant,
    tenantData: PostSbEnvironmentTenantDTO,
    sbEnvironment: SbEnvironment
  ) {
    // Update tenant name if changed
    if (existingTenant.name !== tenantData.name) {
      await this.edfiTenantsRepository.save({
        ...existingTenant,
        name: tenantData.name,
      });
    }

    // Update ODS instances using the same sync logic as creation
    if (tenantData.odss && tenantData.odss.length > 0) {
      // Determine environment version and type
      const version = sbEnvironment.configPublic?.version || 'v2';

      if (version === 'v1') {
        // Use V1 sync method
        const metaOds = this.createODSObjectV1(tenantData);
        await this.saveSyncableOdsV1(metaOds, existingTenant);
      } else {
        // Use V2 sync method
        const metaOds = this.createODSObject(tenantData);
        await this.saveSyncableOds(metaOds, existingTenant);
      }
    } else {
      // If no ODS instances provided, remove all existing ones
      await this.removeAllOdsForTenant(existingTenant);
    }
  }

  /**
   * Create a new tenant with its ODS instances
   */
  private async createNewTenant(
    sbEnvironment: SbEnvironment,
    tenantData: PostSbEnvironmentTenantDTO
  ) {
    // Create the tenant entity
    const newTenant = await this.edfiTenantsRepository.save({
      name: tenantData.name,
      sbEnvironmentId: sbEnvironment.id,
    });

    // Create ODS instances if provided
    if (tenantData.odss && tenantData.odss.length > 0) {
      // Determine environment version
      const version = sbEnvironment.configPublic?.version || 'v2';

      if (version === 'v1') {
        // Use V1 sync method
        const metaOds = this.createODSObjectV1(tenantData);
        await this.saveSyncableOdsV1(metaOds, newTenant);
      } else {
        // Use V2 sync method
        const metaOds = this.createODSObject(tenantData);
        await this.saveSyncableOds(metaOds, newTenant);
      }
    }

    this.logger.log(`Created new tenant ${tenantData.name} with ${tenantData.odss?.length || 0} ODS instances`);
  }

  /**
   * Remove a tenant and all its associated data
   */
  private async removeTenant(tenant: EdfiTenant) {
    await this.entityManager.transaction(async (em) => {
      // Remove all EdOrgs for this tenant's ODS instances
      await em.getRepository(Edorg).delete({ edfiTenantId: tenant.id });

      // Remove all ODS instances for this tenant
      await em.getRepository(Ods).delete({ edfiTenantId: tenant.id });

      // Remove the tenant itself
      await em.getRepository(EdfiTenant).delete(tenant.id);
    });
  }

  /**
   * Remove all ODS instances for a tenant
   */
  private async removeAllOdsForTenant(tenant: EdfiTenant) {
    await this.entityManager.transaction(async (em) => {
      // Remove all EdOrgs for this tenant's ODS instances
      await em.getRepository(Edorg).delete({ edfiTenantId: tenant.id });

      // Remove all ODS instances for this tenant
      await em.getRepository(Ods).delete({ edfiTenantId: tenant.id });
    });
  }

}
