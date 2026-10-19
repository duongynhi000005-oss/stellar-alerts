import { FastifyInstance } from 'fastify';
import { auditController } from './audit.controller';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/audit/merkle/root', auditController.getDailyRoot.bind(auditController));
  app.get('/audit/merkle/proof/:alertId', auditController.getAlertProof.bind(auditController));
  app.post('/audit/merkle/verify', auditController.verifyProof.bind(auditController));
}
