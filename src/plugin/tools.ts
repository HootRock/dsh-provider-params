/**
 * The four read-only tools exposed by dsh-provider-params.
 *
 * Every tool is deterministic and local: no filesystem writes, no network, no
 * model call. Tool names are a stable API; `params.*` operate on the bundled
 * table and `json.repair` operates on caller-supplied text.
 *
 * @module dsh-provider-params/plugin/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compareVendors, listVendors, mapParams } from '../core/mapping.js'
import { repairJson } from '../core/repair.js'
import { paramList, vendorIds } from '../core/rosetta.js'

const text = (value: string) => [{ type: 'text' as const, text: value }]

const droppedSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    param: { type: 'string', required: true },
    from_wire: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

const addedSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    param: { type: 'string', required: true },
    wire_name: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

const adjustedSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    param: { type: 'string', required: true },
    wire_name: { type: 'string', required: true },
    from: { type: 'number', required: true },
    to: { type: 'number', required: true },
    rule: { type: 'string', required: true },
  },
} as const

const unknownSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    param: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

const endpointSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    supported: { type: 'boolean', required: true },
    required: { type: 'boolean', required: true },
    range: { type: 'string', required: true },
    notes: { type: 'string', required: true },
  },
} as const

/** Build the four tool definitions. */
export function createTools() {
  const map = defineTool({
    name: 'params.map',
    description:
      'Map an LLM request fragment from one vendor to another (11 vendors, 13 canonical fields). Returns the target wire shape plus dropped/added/adjusted/unknown parameters. Read-only, deterministic, no network.',
    parameters: {
      from: { type: 'string', required: true },
      to: { type: 'string', required: true },
      params: { type: 'object', additionalProperties: true, required: true },
      strict: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          mapped: { type: 'json', required: true },
          dropped: { type: 'array', required: true, items: droppedSchema },
          added: { type: 'array', required: true, items: addedSchema },
          adjusted: { type: 'array', required: true, items: adjustedSchema },
          unknown: { type: 'array', required: true, items: unknownSchema },
        },
      },
      render: (_args, value) =>
        text(
          `params.map ${value.from} -> ${value.to}: mapped=${Object.keys(value.mapped as Record<string, unknown>).length} dropped=${value.dropped.length} added=${value.added.length} adjusted=${value.adjusted.length} unknown=${value.unknown.length}`,
        ),
    },
    async execute(args) {
      return mapParams(args.from, args.to, args.params, { strict: args.strict })
    },
  })

  const compare = defineTool({
    name: 'params.compare',
    description:
      'Compare the parameter semantics of two vendors: same/renamed/removed/added/absent per canonical field, with wire names and documented ranges. Read-only.',
    parameters: {
      from: { type: 'string', required: true },
      to: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                param: { type: 'string', required: true },
                from: { ...endpointSchema, required: true as const },
                to: { ...endpointSchema, required: true as const },
                relation: { type: 'string', required: true },
                notes: { type: 'string', required: true },
              },
            },
          },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: true as const,
            properties: {
              same: { type: 'number', required: true },
              renamed: { type: 'number', required: true },
              removed: { type: 'number', required: true },
              added: { type: 'number', required: true },
              absent: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) =>
        text(
          `params.compare ${value.from} -> ${value.to}: same=${value.summary.same} renamed=${value.summary.renamed} removed=${value.summary.removed} added=${value.summary.added} absent=${value.summary.absent}`,
        ),
    },
    async execute(args) {
      return compareVendors(args.from, args.to)
    },
  })

  const vendors = defineTool({
    name: 'params.vendors',
    description:
      'List supported vendors and their parameter fields (wire name, supported flag, required flag, documented range, notes). Read-only.',
    parameters: {
      vendor: { type: 'string' },
      include_unsupported: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          params: { type: 'array', required: true, items: { type: 'string' } },
          vendors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                api_style: { type: 'string', required: true },
                source: { type: 'string', required: true },
                total: { type: 'number', required: true },
                supported: { type: 'number', required: true },
                fields: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      param: { type: 'string', required: true },
                      wire_name: { type: 'string', required: true },
                      supported: { type: 'boolean', required: true },
                      required: { type: 'boolean', required: true },
                      range: { type: 'string', required: true },
                      notes: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => text(`params.vendors: ${value.count}/${vendorIds().length} vendors, ${paramList().length} fields each`),
    },
    async execute(args) {
      return listVendors({ vendor: args.vendor, include_unsupported: args.include_unsupported })
    },
  })

  const repair = defineTool({
    name: 'json.repair',
    description:
      'Deterministically repair broken JSON text: escape raw control characters, remove trailing commas, close truncated strings/containers, and complete declared required fields with null placeholders. Never fabricates data; returns every action. Read-only.',
    parameters: {
      text: { type: 'string', required: true },
      schema: { type: 'json' },
      strategies: {
        type: 'object',
        additionalProperties: false,
        properties: {
          escape_repair: { type: 'boolean' },
          trailing_comma: { type: 'boolean' },
          truncation_closure: { type: 'boolean' },
          field_completion: { type: 'boolean' },
        },
      },
      max_steps: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          repaired: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            required: true,
          },
          value: { type: 'json', required: true },
          actions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                op: { type: 'string', required: true },
                path: { type: 'string', required: true },
                before: { type: 'string', required: true },
                after: { type: 'string', required: true },
              },
            },
          },
          strategies: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
          validated: { type: 'boolean', required: true },
          placeholders: { type: 'array', required: true, items: { type: 'string' } },
          error: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
            required: true,
          },
        },
      },
      render: (_args, value) =>
        text(
          `json.repair: ok=${value.ok} actions=${value.actions.length} strategies=${value.strategies.join(',') || 'none'} placeholders=${value.placeholders.length}`,
        ),
    },
    async execute(args) {
      const strategies = args.strategies === undefined
        ? undefined
        : {
            escapeRepair: args.strategies.escape_repair,
            trailingComma: args.strategies.trailing_comma,
            truncationClosure: args.strategies.truncation_closure,
            fieldCompletion: args.strategies.field_completion,
          }
      return repairJson(args.text, {
        schema: args.schema,
        strategies,
        maxSteps: args.max_steps,
      })
    },
  })

  return [map, compare, vendors, repair]
}
