import { createRootRoute, createRoute, createRouter, Link, type SearchSchemaInput } from '@tanstack/react-router'
import { PageHeader } from '@/components/page'
import { Shell } from '@/components/shell'
import { basePath } from '@/lib/env'
import { parseGraphSearch, parseListSearch, type GraphSearch, type ListSearch, type ListSearchInput, type ListSpec } from '@/lib/search'
import { candidaciesSpec, datasetRowsSpec, datasetsSpec, documentsSpec, financeSpec, operationsRouteSpec, parliamentSpec, peopleRouteSpec, recordsSpec, rightsSpec, sourcesSpec, statisticsRouteSpec } from '@/lib/specs'
import { ConfiguredOnly, PublicGate } from '@/routes/access'
import { DatasetDetailPage, DatasetsPage } from '@/routes/datasets'
import { DocumentsPage } from '@/routes/documents'
import { ElectionDetailPage, ElectionsPage } from '@/routes/elections'
import { ElectorateVersionDetailPage, PartyIdentityDetailPage } from '@/routes/entity-detail'
import { FinancePage } from '@/routes/finance'
import { GraphPage } from '@/routes/graph'
import { IdentityDetailPage } from '@/routes/identity-detail'
import { OperationsPage } from '@/routes/operations'
import { OverviewPage } from '@/routes/overview'
import { ParliamentPage } from '@/routes/parliament'
import { PeoplePage } from '@/routes/people'
import { RecordDetailPage } from '@/routes/record-detail'
import { RecordsPage } from '@/routes/records'
import { RightsPage } from '@/routes/rights'
import { SourceDetailPage } from '@/routes/source-detail'
import { SourcesPage } from '@/routes/sources'
import { StatisticsPage } from '@/routes/statistics'

/** Links may pass any subset of a list's search; the route always receives the validated, defaulted form. */
function listSearch<F extends string>(spec: ListSpec<F>) {
  return (raw: ListSearchInput<F> & SearchSchemaInput): ListSearch<F> => parseListSearch(spec, raw as unknown as Record<string, unknown>)
}

function NotFound() {
  return (
    <>
      <PageHeader eyebrow="Not found" title="There is no page at this address">
        <p>The address may be mistyped, or the page may have moved.</p>
      </PageHeader>
      <Link to="/" className="doc-link">Go to the overview</Link>
    </>
  )
}

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound })

// Evidence rows: shown once the database reports the release gates as open.
const inspectorRoute = createRoute({ getParentRoute: () => rootRoute, id: '_released', component: PublicGate })
const inspector = () => inspectorRoute
// Catalogue and schema: readable whatever the release state.
const catalogueRoute = createRoute({ getParentRoute: () => rootRoute, id: '_catalogue', component: ConfiguredOnly })
const datasetsRoute = createRoute({ getParentRoute: () => catalogueRoute, path: '/datasets', validateSearch: listSearch(datasetsSpec), component: DatasetsPage })
const datasetDetailRoute = createRoute({ getParentRoute: () => catalogueRoute, path: '/datasets/$schema/$name', validateSearch: listSearch(datasetRowsSpec), component: DatasetDetailPage })

const overviewRoute = createRoute({ getParentRoute: inspector, path: '/', component: OverviewPage })
const sourcesRoute = createRoute({ getParentRoute: inspector, path: '/sources', validateSearch: listSearch(sourcesSpec), component: SourcesPage })
const sourceDetailRoute = createRoute({ getParentRoute: inspector, path: '/sources/$sourceId', component: SourceDetailPage })
const recordsRoute = createRoute({ getParentRoute: inspector, path: '/records', validateSearch: listSearch(recordsSpec), component: RecordsPage })
const recordDetailRoute = createRoute({ getParentRoute: inspector, path: '/records/$recordId', component: RecordDetailPage })
const peopleRoute = createRoute({ getParentRoute: inspector, path: '/people', validateSearch: listSearch(peopleRouteSpec), component: PeoplePage })
const identityDetailRoute = createRoute({ getParentRoute: inspector, path: '/people/$identityId', component: IdentityDetailPage })
const partyIdentityRoute = createRoute({ getParentRoute: inspector, path: '/parties/$identityId', component: PartyIdentityDetailPage })
const electorateVersionRoute = createRoute({ getParentRoute: inspector, path: '/electorates/$versionId', component: ElectorateVersionDetailPage })
const parliamentRoute = createRoute({ getParentRoute: inspector, path: '/parliament', validateSearch: listSearch(parliamentSpec), component: ParliamentPage })
const electionsRoute = createRoute({ getParentRoute: inspector, path: '/elections', component: ElectionsPage })
const electionDetailRoute = createRoute({ getParentRoute: inspector, path: '/elections/$slug', validateSearch: listSearch(candidaciesSpec), component: ElectionDetailPage })
const documentsRoute = createRoute({ getParentRoute: inspector, path: '/documents', validateSearch: listSearch(documentsSpec), component: DocumentsPage })
const financeRoute = createRoute({ getParentRoute: inspector, path: '/finance', validateSearch: listSearch(financeSpec), component: FinancePage })
const statisticsRoute = createRoute({ getParentRoute: inspector, path: '/statistics', validateSearch: listSearch(statisticsRouteSpec), component: StatisticsPage })
const rightsRoute = createRoute({ getParentRoute: inspector, path: '/rights', validateSearch: listSearch(rightsSpec), component: RightsPage })
const operationsRoute = createRoute({ getParentRoute: inspector, path: '/operations', validateSearch: listSearch(operationsRouteSpec), component: OperationsPage })
const graphRoute = createRoute({ getParentRoute: inspector, path: '/graph', validateSearch: (raw: GraphSearch & SearchSchemaInput): GraphSearch => parseGraphSearch(raw as unknown as Record<string, unknown>), component: GraphPage })

const routeTree = rootRoute.addChildren([
  catalogueRoute.addChildren([datasetsRoute, datasetDetailRoute]),
  inspectorRoute.addChildren([
    overviewRoute,
    sourcesRoute,
    sourceDetailRoute,
    recordsRoute,
    recordDetailRoute,
    peopleRoute,
    identityDetailRoute,
    partyIdentityRoute,
    electorateVersionRoute,
    parliamentRoute,
    electionsRoute,
    electionDetailRoute,
    documentsRoute,
    financeRoute,
    statisticsRoute,
    rightsRoute,
    operationsRoute,
    graphRoute,
  ]),
])

export function createAppRouter() {
  return createRouter({
    routeTree,
    basepath: basePath,
    // Strict search: a route sees ONLY what its validateSearch returned. Without this the router merges the raw
    // query string into every match, so a value a validator dropped (an unknown enum, a withheld graph kind)
    // would still reach the page and its queries.
    search: { strict: true },
    defaultPreload: false,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  })
}

export const router = createAppRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
