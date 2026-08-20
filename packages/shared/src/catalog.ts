import { z } from 'zod'

export const locationKindSchema = z.enum(['MARKET', 'WAREHOUSE'])
export type LocationKind = z.infer<typeof locationKindSchema>

export const familyAssignmentSourceSchema = z.enum(['LEXICAL', 'SYNONYM', 'VISUAL', 'MANUAL'])
export type FamilyAssignmentSource = z.infer<typeof familyAssignmentSourceSchema>
