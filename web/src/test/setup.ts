// Vitest setup. Tests use invented values labelled as fixtures; none is evidence.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
