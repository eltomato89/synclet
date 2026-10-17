package tech.jensk.synclet.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.ui.accounts.AccountsScreen
import tech.jensk.synclet.ui.browser.FolderScreen
import tech.jensk.synclet.ui.browser.SpacesScreen
import tech.jensk.synclet.ui.more.MoreScreen
import tech.jensk.synclet.ui.preview.PreviewScreen
import tech.jensk.synclet.ui.recent.RecentScreen
import tech.jensk.synclet.ui.search.SearchScreen
import tech.jensk.synclet.ui.settings.SettingsScreen
import tech.jensk.synclet.ui.trash.TrashScreen
import tech.jensk.synclet.ui.uploads.UploadsScreen

@Composable
fun AppNavHost(graph: AppGraph, nav: NavHostController) {
    val openFolder = { route: FolderRoute -> nav.navigate(route) }
    val openPreview = { route: PreviewRoute -> nav.navigate(route) }
    val back = { nav.popBackStack(); Unit }
    // Trash and Uploads are tabs on a tablet (no back arrow) and entries of "More" on a phone.
    val backIfFromMore = { if (nav.previousBackStackEntry?.destination?.hasRoute(MoreRoute::class) == true) back else null }

    NavHost(nav, startDestination = FilesRoute) {
        composable<FilesRoute> {
            val key by graph.selectedAccountKey.collectAsStateWithLifecycle()
            // MainActivity only shows the shell with at least one account; until the key settles, show nothing.
            key?.let { SpacesScreen(graph, it, onOpenFolder = openFolder) } ?: Box(Modifier.fillMaxSize())
        }
        composable<FolderRoute> {
            FolderScreen(graph, it.toRoute(), onOpenFolder = openFolder, onOpenPreview = openPreview,
                onSearch = { r -> nav.navigate(r) }, onBack = back)
        }
        composable<PreviewRoute> { PreviewScreen(graph, it.toRoute(), onBack = back) }
        composable<SearchRoute> { SearchScreen(graph, it.toRoute(), onOpenFolder = openFolder, onOpenPreview = openPreview) }
        composable<RecentRoute> { RecentScreen(graph, onOpenPreview = openPreview) }
        composable<TrashRoute> { TrashScreen(graph, onBack = backIfFromMore()) }
        composable<UploadsRoute> { UploadsScreen(graph, onBack = backIfFromMore()) }
        composable<MoreRoute> {
            MoreScreen(
                onTrash = { nav.navigate(TrashRoute) },
                onUploads = { nav.navigate(UploadsRoute) },
                onAccounts = { nav.navigate(AccountsRoute) },
                onSettings = { nav.navigate(SettingsRoute) },
            )
        }
        composable<AccountsRoute> { AccountsScreen(graph, onBack = back) }
        composable<SettingsRoute> { SettingsScreen(graph, onBack = back) }
    }
}
