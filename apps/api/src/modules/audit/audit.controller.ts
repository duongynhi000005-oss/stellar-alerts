import { FastifyRequest, FastifyReply } from 'fastify';
import { apiMerkleAuditService } from './merkle.service';
import {
  getDailyRootQuerySchema,
  getAlertProofParamsSchema,
  verifyProofBodySchema,
} from './audit.schema';
import { zodValidationError } from '../../lib/errors';

export class AuditController {
  async getDailyRoot(request: FastifyRequest, reply: FastifyReply) {
    const parsed = getDailyRootQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid query parameters');
    }

    const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
    const result = await apiMerkleAuditService.computeDailyAlertMerkleRoot(date);

    if (!result) {
      return reply.status(404).send({
        success: false,
        error: `No alert delivery logs found for date ${date}`,
      });
    }

    return reply.send({
      success: true,
      data: result,
    });
  }

  async getAlertProof(request: FastifyRequest, reply: FastifyReply) {
    const parsedParams = getAlertProofParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw zodValidationError(parsedParams, 'Invalid alert ID parameter');
    }

    const parsedQuery = getDailyRootQuerySchema.safeParse(request.query);
    const date = parsedQuery.success ? parsedQuery.data.date : undefined;

    const result = await apiMerkleAuditService.generateAlertProof(parsedParams.data.alertId, date);

    if (!result) {
      return reply.status(404).send({
        success: false,
        error: `Alert with ID "${parsedParams.data.alertId}" not found in delivery records`,
      });
    }

    return reply.send({
      success: true,
      data: result,
    });
  }

  async verifyProof(request: FastifyRequest, reply: FastifyReply) {
    const parsed = verifyProofBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid proof verification payload');
    }

    const { proof, root, record } = parsed.data;

    let valid = false;
    if (record) {
      valid = apiMerkleAuditService.verifyRecordInclusion(record as any, proof, root);
    } else {
      valid = apiMerkleAuditService.verifyProof(proof, root);
    }

    return reply.send({
      success: true,
      valid,
    });
  }
}

export const auditController = new AuditController();
