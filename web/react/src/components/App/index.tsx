import { ContentsUrlParams, getAPIBase, getContentsUrl, POLL_WAIT, setNamespace } from 'api'
import Header from 'components/Header'
import ResourceFiltersContext from 'contexts/resource-filters'
import _ from 'lodash'
import JSONContentResponse, { Parse } from 'models/contentresponse'
import Overview from 'pages/Overview'
import React, { Component } from 'react'
import { Redirect, Route, RouteComponentProps, Switch, withRouter } from 'react-router-dom'
import ReactTooltip from 'react-tooltip'

import Navigation from '../Navigation'

import getInitialState from './state/getInitialState'
import './styles.scss'

interface AppState {
  isLoading: boolean
  hasError: boolean
  errorMessage: string
  navigation: { sections: NavigationSectionType[] }
  currentNavLinkPath: NavigationSectionType[]
  namespaceOption: NamespaceOption
  namespaceOptions: NamespaceOption[]
  title: string
  contentResponse: JSONContentResponse
  resourceFilters: string[]
}

class App extends Component<RouteComponentProps, AppState> {
  private lastFetchedNamespace: string

  private source: any

  constructor(props) {
    super(props)
    this.state = {
      title: '',
      isLoading: true, // to do the initial data fetch
      hasError: false,
      errorMessage: '',
      navigation: null,
      currentNavLinkPath: [],
      namespaceOption: { label: 'default', value: 'default' },
      namespaceOptions: [],
      contentResponse: null,
      resourceFilters: [],
    }
  }

  async componentDidMount() {
    const { location: initialLocation } = this.props
    const initialState = await getInitialState(initialLocation.pathname)
    this.setState(initialState as AppState)
    this.setEventSourceStream(this.props.location.pathname, this.state.namespaceOption.value)
  }

  componentDidUpdate({ location: previousLocation }, { namespaceOption: previousNamespace }) {
    const { location } = this.props
    const { namespaceOption } = this.state

    const namespace = namespaceOption.value
    const prevNamespace = previousNamespace.value

    if (location.pathname !== previousLocation.pathname || namespace !== prevNamespace) {
      this.setEventSourceStream(location.pathname, namespace)
    }

    // this is required to make tool tips show.
    ReactTooltip.rebuild()
  }

  componentWillUnmount(): void {
    if (this.source) {
      this.source.close()
      this.source = null
    }
  }

  setEventSourceStream(path: string, namespace: string) {
    // clear state and this.source on change
    if (this.source) {
      this.source.close()
      this.source = null
    }

    if (!path || !namespace) return

    const params: ContentsUrlParams = {
      poll: POLL_WAIT,
    }

    const { resourceFilters } = this.state
    if (resourceFilters && resourceFilters.length) params.filter = resourceFilters

    const url = getContentsUrl(path, namespace, params)

    this.source = new window.EventSource(`${getAPIBase()}/${url}`)
    this.setState({ isLoading: true, hasError: false, contentResponse: null })

    this.source.addEventListener('message', (e) => {
      const contentResponse = Parse(e.data)

      this.setState({
        contentResponse,
        isLoading: false,
        hasError: false,
      })
    })

    this.source.addEventListener('navigation', (e) => {
      const data = JSON.parse(e.data)
      this.setState({ navigation: data })
    })

    this.source.addEventListener('namespaces', (e) => {
      const data = JSON.parse(e.data)
      const updated = data.namespaces.map((ns) => ({
        label: ns,
        value: ns,
      }))

      // TODO if current namespace is not in list, redirect to the
      // the first item in the list.
      this.setState({ namespaceOptions: updated })
    })

    this.source.addEventListener('error', () => {
      this.setState({ isLoading: false })
      this.setError(true, 'Looks like the back end source has gone away. Retrying...')
    })
  }

  onNamespaceChange = async (namespaceOption) => {
    const { value } = namespaceOption
    this.props.history.push(`/content/overview/namespace/${value}/`)
    this.setState({ namespaceOption })
  }

  refreshEventStream = () => {
    const { location } = this.props
    const { namespaceOption } = this.state
    this.setEventSourceStream(location.pathname, namespaceOption.value)
  }

  onResourceFiltersChange = (newFilterTags) => {
    const newResourceFilters = _.uniq(newFilterTags) as string[]
    this.setState({ resourceFilters: newResourceFilters }, this.refreshEventStream)
  }

  onLabelClick = (key: string, value: string) => {
    const tag = `${key}:${value}`
    const { resourceFilters } = this.state
    this.onResourceFiltersChange([...resourceFilters, tag])
  }

  setError = (hasError: boolean, errorMessage?: string): void => {
    errorMessage = errorMessage || 'Oops, something is not right, try again.'
    this.setState({ hasError, errorMessage })
  }

  render() {
    const {
      isLoading,
      hasError,
      errorMessage,
      navigation,
      currentNavLinkPath,
      namespaceOptions,
      namespaceOption,
      title,
      resourceFilters,
      contentResponse,
    } = this.state

    let currentNamespace = null
    if (namespaceOption) {
      currentNamespace = namespaceOption.value
    }

    let navSections = null
    let rootNavigationPath = `/content/overview/namespace/${currentNamespace}/`
    if (navigation && navigation.sections) {
      navSections = navigation.sections
      rootNavigationPath = navigation.sections[0].path
    }

    return (
      <div className='app'>
        <Header
          namespaceOptions={namespaceOptions}
          namespace={currentNamespace}
          namespaceValue={namespaceOption}
          onNamespaceChange={this.onNamespaceChange}
          resourceFilters={resourceFilters}
          onResourceFiltersChange={this.onResourceFiltersChange}
        />
        <ResourceFiltersContext.Provider value={{ onLabelClick: this.onLabelClick }}>
          <div className='app-page'>
            <div className='app-nav'>
              <Navigation
                navSections={navSections}
                currentNavLinkPath={currentNavLinkPath}
                onNavChange={(linkPath) => this.setState({ currentNavLinkPath: linkPath })}
              />
            </div>
            <div className='app-main'>
              <Switch>
                <Redirect exact from='/' to={rootNavigationPath} />
                <Route
                  render={(props) => (
                    <Overview
                      {...props}
                      title={title}
                      isLoading={isLoading}
                      hasError={hasError}
                      errorMessage={errorMessage}
                      setError={this.setError}
                      data={contentResponse}
                    />
                  )}
                />
              </Switch>
            </div>
            <ReactTooltip html />
          </div>
        </ResourceFiltersContext.Provider>
      </div>
    )
  }
}

export default withRouter(App)