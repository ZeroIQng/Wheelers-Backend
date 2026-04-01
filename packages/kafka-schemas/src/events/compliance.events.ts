/**
 * Compliance and KYC-related events
 */

export interface KycInitiatedEvent {
  type: 'compliance.kyc.initiated';
  data: {
    kycId: string;
    userId: string;
    kycLevel: 'level1' | 'level2' | 'level3';
    initiatedAt: Date;
  };
}

export interface KycCompletedEvent {
  type: 'compliance.kyc.completed';
  data: {
    kycId: string;
    userId: string;
    kycLevel: 'level1' | 'level2' | 'level3';
    status: 'approved' | 'rejected' | 'pending_review';
    completedAt: Date;
  };
}

export interface DocumentVerifiedEvent {
  type: 'compliance.document.verified';
  data: {
    documentId: string;
    userId: string;
    documentType: 'passport' | 'driving_license' | 'national_id' | 'address_proof';
    verificationStatus: 'verified' | 'rejected' | 'expired';
    verifiedAt: Date;
  };
}

export interface FraudDetectedEvent {
  type: 'compliance.fraud.detected';
  data: {
    fraudId: string;
    userId: string;
    rideId?: string;
    fraudType: 'identity_fraud' | 'payment_fraud' | 'account_abuse' | 'other';
    riskScore: number; // 0-100
    detectedAt: Date;
    description: string;
  };
}

export interface AccountSuspendedEvent {
  type: 'compliance.account.suspended';
  data: {
    userId: string;
    reason: string;
    suspensionDuration?: number; // in days, undefined for permanent
    suspendedAt: Date;
  };
}

export interface ComplianceReportGeneratedEvent {
  type: 'compliance.report.generated';
  data: {
    reportId: string;
    userId: string;
    reportType: 'monthly' | 'quarterly' | 'annual' | 'on_demand';
    reportData: Record<string, unknown>;
    generatedAt: Date;
  };
}

export type ComplianceEvent =
  | KycInitiatedEvent
  | KycCompletedEvent
  | DocumentVerifiedEvent
  | FraudDetectedEvent
  | AccountSuspendedEvent
  | ComplianceReportGeneratedEvent;
