import { z } from "zod";
import { featureIdSchema, specifierTurnSchema } from "../agent/agent-turn.ts";
import { SpecificationReviewDecision as ReviewDecision } from "../workflow-values.ts";

export const specificationReviewDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal(ReviewDecision.Approved),
    feedback: z.null(),
  }),
  z.object({
    decision: z.literal(ReviewDecision.ChangesRequested),
    feedback: z.string().min(1),
  }),
]);
export type SpecificationReviewDecision = z.infer<typeof specificationReviewDecisionSchema>;

export const publishedSpecificationSchema = z.object({
  sequence: z.number().int().positive(),
  featureId: featureIdSchema,
  path: z.string().regex(/^specifications\/[0-9]{6}-[a-z0-9]+(?:-[a-z0-9]+)*\.feature$/),
  createdAt: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceReviewId: z.string().min(1),
});
export type PublishedSpecification = z.infer<typeof publishedSpecificationSchema>;

const specificationReviewBaseSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  specification: specifierTurnSchema,
});

export const specificationReviewSchema = z.discriminatedUnion("decision", [
  specificationReviewBaseSchema.extend({
    decision: z.literal(ReviewDecision.Approved),
    feedback: z.null(),
    publishedSpecification: publishedSpecificationSchema,
  }),
  specificationReviewBaseSchema.extend({
    decision: z.literal(ReviewDecision.ChangesRequested),
    feedback: z.string().min(1),
    publishedSpecification: z.null(),
  }),
]);
export type SpecificationReview = z.infer<typeof specificationReviewSchema>;
