import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import {
  publishedSpecificationSchema,
  type PublishedSpecification,
  type SpecifierTurn,
} from "../../domain/schemas.ts";
import type {
  PublishSpecificationRequest,
  SpecificationJournal,
} from "../../application/ports/development-services.ts";

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    nextSequence: z.number().int().positive(),
    specifications: z.array(publishedSpecificationSchema),
  })
  .superRefine((manifest, context) => {
    manifest.specifications.forEach((specification, index) => {
      const expected = index + 1;

      if (specification.sequence !== expected) {
        context.addIssue({
          code: "custom",
          message: `Expected sequence ${expected}; got ${specification.sequence}.`,
          path: ["specifications", index, "sequence"],
        });
      }
    });

    if (manifest.nextSequence !== manifest.specifications.length + 1) {
      context.addIssue({
        code: "custom",
        message: "nextSequence must immediately follow the final specification.",
        path: ["nextSequence"],
      });
    }

    const reviewIds = manifest.specifications.map(({ sourceReviewId }) => sourceReviewId);

    if (new Set(reviewIds).size !== reviewIds.length) {
      context.addIssue({
        code: "custom",
        message: "sourceReviewId values must be unique.",
        path: ["specifications"],
      });
    }
  });

export type SpecificationManifest = z.infer<typeof manifestSchema>;

function emptyManifest(): SpecificationManifest {
  return { schemaVersion: 1, nextSequence: 1, specifications: [] };
}

function digest(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function commentBlock(label: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`# ${label}: none`];
  }

  return [
    `# ${label}:`,
    ...values.flatMap((value) =>
      value.split("\n").map((line, index) => `# ${index === 0 ? "- " : "  "}${line}`),
    ),
  ];
}

function renderSpecification(
  sequence: number,
  sourceReviewId: string,
  specification: SpecifierTurn,
): string {
  return [
    `# Sequence: ${sequence}`,
    `# Feature ID: ${specification.featureId}`,
    `# Approved review: ${sourceReviewId}`,
    ...commentBlock("Assumptions", specification.assumptions),
    ...commentBlock("Out of scope", specification.outOfScope),
    "",
    specification.specification.trim(),
    "",
  ].join("\n");
}

async function readManifest(workspace: string): Promise<SpecificationManifest> {
  const path = resolve(workspace, "specifications", "manifest.json");

  try {
    return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyManifest();
    }

    throw error;
  }
}

async function verifyEntry(
  workspace: string,
  specification: PublishedSpecification,
): Promise<void> {
  const content = await readFile(resolve(workspace, specification.path), "utf8");
  const actual = digest(content);

  if (actual !== specification.sha256) {
    throw new Error(
      `Specification integrity check failed for ${specification.path}: expected ${specification.sha256}, got ${actual}.`,
    );
  }
}

export async function loadVerifiedSpecificationArchive(
  specificationsDirectory: string,
): Promise<SpecificationManifest> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(specificationsDirectory, "manifest.json"), "utf8")),
  );

  for (const specification of manifest.specifications) {
    const content = await readFile(
      resolve(specificationsDirectory, basename(specification.path)),
      "utf8",
    );
    const actual = digest(content);

    if (actual !== specification.sha256) {
      throw new Error(
        `Specification integrity check failed for ${specification.path}: expected ${specification.sha256}, got ${actual}.`,
      );
    }
  }

  return manifest;
}

export class FileSpecificationJournal implements SpecificationJournal {
  async publish({
    workspace,
    sourceReviewId,
    specification,
  }: PublishSpecificationRequest): Promise<PublishedSpecification> {
    const manifest = await readManifest(workspace);
    const existing = manifest.specifications.find((item) => item.sourceReviewId === sourceReviewId);

    if (existing) {
      await verifyEntry(workspace, existing);

      const requestedContent = renderSpecification(
        existing.sequence,
        sourceReviewId,
        specification,
      );

      if (digest(requestedContent) !== existing.sha256) {
        throw new Error(`Review ${sourceReviewId} is already published with different content.`);
      }

      return existing;
    }

    const sequence = manifest.nextSequence;
    const fileName = `${String(sequence).padStart(6, "0")}-${specification.featureId}.feature`;
    const relativePath = `specifications/${fileName}`;
    const directory = resolve(workspace, "specifications");
    const content = renderSpecification(sequence, sourceReviewId, specification);
    const published = publishedSpecificationSchema.parse({
      sequence,
      featureId: specification.featureId,
      path: relativePath,
      createdAt: new Date().toISOString(),
      sha256: digest(content),
      sourceReviewId,
    });
    const nextManifest = manifestSchema.parse({
      ...manifest,
      nextSequence: sequence + 1,
      specifications: [...manifest.specifications, published],
    });

    await mkdir(directory, { recursive: true });
    const featurePath = resolve(workspace, relativePath);
    const featureTemporaryPath = `${featurePath}.tmp`;
    await Bun.write(featureTemporaryPath, content);
    await rename(featureTemporaryPath, featurePath);

    const manifestPath = resolve(directory, "manifest.json");
    const manifestTemporaryPath = `${manifestPath}.tmp`;
    await Bun.write(manifestTemporaryPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    await rename(manifestTemporaryPath, manifestPath);

    return published;
  }

  async verify(workspace: string): Promise<void> {
    const manifest = await readManifest(workspace);

    for (const specification of manifest.specifications) {
      await verifyEntry(workspace, specification);
    }
  }
}

export class InMemorySpecificationJournal implements SpecificationJournal {
  private readonly specifications: PublishedSpecification[] = [];

  publish({
    sourceReviewId,
    specification,
  }: PublishSpecificationRequest): Promise<PublishedSpecification> {
    const existing = this.specifications.find((item) => item.sourceReviewId === sourceReviewId);

    if (existing) {
      return Promise.resolve(existing);
    }

    const sequence = this.specifications.length + 1;
    const content = specification.specification;
    const published = publishedSpecificationSchema.parse({
      sequence,
      featureId: specification.featureId,
      path: `specifications/${String(sequence).padStart(6, "0")}-${specification.featureId}.feature`,
      createdAt: new Date().toISOString(),
      sha256: digest(content),
      sourceReviewId,
    });
    this.specifications.push(published);

    return Promise.resolve(published);
  }

  verify(): Promise<void> {
    return Promise.resolve();
  }
}
