import Ember from 'ember';

const { RSVP, inject, Service, computed, Application, Logger } = Ember;
const { Promise } = RSVP;

export default Service.extend({

  routingService: inject.service('-routing'),

  name: 'keycloak session',

  /**
   * Value used in calls to KeyCloak.updateToken(minValidity)
   */
  minValidity: 30,

  /**
   * Bound property to track session state. Indicates that a keycloak session has been successfully created.
   */
  ready: false,

  /**
   * Bound property to track session state. Indicates that the session has authenticated.
   */
  authenticated: false,

  /**
   * Bound property to track session state. Track last activity time.
   */
  timestamp: new Date(),

  /**
   * Default route to transition to after successful login
   */
  defaultLoginRoute: 'logged-in',

  /**
   * Default route to transition to after logout. This will be used to calculate the redirectUri
   * parameter used when calling Keycloak.logout() when no explicit value is given. This only has
   * effect when the onLoad init option is set to 'check-sso'.
   */
  defaultLogoutRoute: 'logged-out',

  /**
   * Keycloak.init() option. Should be one of 'check-sso' or 'login-required'.
   * See http://www.keycloak.org/documentation.html for complete details.
   */
  onLoad: 'login-required',

  /**
   * Keycloak.init() option. Should be one of 'query' or 'fragment'.
   * See http://www.keycloak.org/documentation.html for complete details.
   */
  responseMode: 'fragment',

  /**
   * Keycloak.init() option. Should be one of 'standard', 'implicit' or 'hybrid'.
   * See http://www.keycloak.org/documentation.html for complete details.
   */
  flow: 'standard',

  /**
   * Keycloak.init() option.
   */
  checkLoginIframe: true,

  /**
   * Keycloak.init() option.
   */
  checkLoginIframeInterval: 5,

  /**
   * Redirect uri to use for login redirection
   */
  defaultLoginRedirectUri: computed('defaultLoginRoute', function () {

    return this._defaultRedirectUri('defaultLoginRoute');
  }),

  /**
   * Redirect uri to use for logout redirection
   */
  defaultLogoutRedirectUri: computed('defaultLogoutRoute', function () {

    return this._defaultRedirectUri('defaultLogoutRoute');
  }),

  /**
   * @param defaultRoute - fall back route
   * @returns {*}
   * @private
   */
  _defaultRedirectUri(defaultRoute) {

    var route = this.get(defaultRoute);
    var router = this.get('routingService.router');

    return `${window.location.origin}${router.generate(route)}`;
  },

  /**
   * @param parameters constructor parameters for Keycloak object - see Keycloak JS adapter docs for details
   */
  installKeycloak(parameters) {

    Logger.debug('Keycloak session :: keycloak');

    var self = this;

    var keycloak = new Keycloak(parameters);

    keycloak.onReady = function (authenticated) {
      Logger.debug('onReady ' + authenticated);
      self.set('ready', true);
      self.set('authenticated', authenticated);
      self.set('timestamp', new Date());
    };

    keycloak.onAuthSuccess = function () {
      Logger.debug('onAuthSuccess');
      self.set('authenticated', true);
      self.set('timestamp', new Date());
    };

    keycloak.onAuthError = function () {
      Logger.debug('onAuthError');
      self.set('authenticated', false);
      self.set('timestamp', new Date());
    };

    keycloak.onAuthRefreshSuccess = function () {
      Logger.debug('onAuthRefreshSuccess');
      self.set('authenticated', true);
      self.set('timestamp', new Date());
    };

    keycloak.onAuthRefreshError = function () {
      Logger.debug('onAuthRefreshError');
      self.set('authenticated', false);
      self.set('timestamp', new Date());
      keycloak.clearToken();
    };

    keycloak.onTokenExpired = function () {
      Logger.debug('onTokenExpired');
      self.set('timestamp', new Date());
    };

    keycloak.onAuthLogout = function () {
      Logger.debug('onAuthLogout');
      self.set('authenticated', false);
      self.set('timestamp', new Date());
    };

    Application.keycloak = keycloak;

    Logger.debug('Keycloak session :: init :: completed');
  },

  initKeycloak() {

    Logger.debug('Keycloak session :: prepare');

    var keycloak = this.get('keycloak');
    var options = this.getProperties('onLoad', 'responseMode', 'checkLoginIframe', 'checkLoginIframeInterval', 'flow');

    //options['onLoad'] = this.get('onLoad');
    //options['responseMode'] = this.get('responseMode');
    //options['checkLoginIframe'] = this.get('checkLoginIframe');
    //options['checkLoginIframeInterval'] = this.get('checkLoginIframeInterval');
    //options['flow'] = this.get('flow');

    return new Promise(function (resolve, reject) {
      keycloak.init(options)
        .success(function (authenticated) {
          resolve(authenticated);
        })
        .error(function (reason) {
          reject(reason);
        });
    });
  },

  keycloak: computed('timestamp', function () {
    return Application.keycloak;
  }),

  subject: computed('timestamp', function () {
    return Application.keycloak.subject;
  }),

  refreshToken: computed('timestamp', function () {
    return Application.keycloak.refreshToken;
  }),

  token: computed('timestamp', function () {
    return Application.keycloak.token;
  }),

  updateToken(){

    // Logger.debug(`Keycloak session :: updateToken`);

    var minValidity = this.get('minValidity');
    var keycloak = this.get('keycloak');

    return new Promise(function (resolve, reject) {

      keycloak.updateToken(minValidity)
        .success(function (refreshed) {
          // Logger.debug(`update token resolved as success refreshed='${refreshed}'`);
          resolve(refreshed);
        })
        .error(function () {
          Logger.debug('update token resolved as error');
          reject(new Error('authentication token update failed'));
        });
    });
  },

  checkTransition(transition){

    var self = this;
    var routingService = this.get('routingService');
    var router = this.get('routingService.router');
    var parser = this._parseRedirectUrl;

    return this.updateToken().then(null, function (reason) {

      Logger.debug(`Keycloak session :: checkTransition :: update token failed reason='${reason}'`);

      var redirectUri = parser(routingService, router, transition);

      return self.login(redirectUri);
    });
  },

  /**
   * Parses the redirect url from the intended route of a transition. WARNING : this relies on private methods in an
   * undocumented class.
   *
   * @param routingService
   * @param router
   * @param transition
   * @returns URL to include as the Keycloak redirect
   * @private
   */
  _parseRedirectUrl(routingService, router, transition) {

    /**
     * First check the intent for an explicit url
     */
    var url = transition.intent.url;

    if (url) {

      url = router.location.formatURL(url);
      Logger.debug(`Keycloak session :: parsing explicit intent URL from transition :: '${url}'`);

    } else {

      /**
       * If no explicit url try to generate one
       */
      url = routingService.generateURL(transition.targetName, transition.intent.contexts, transition.queryParams);
      Logger.debug(`Keycloak session :: parsing implicit intent URL from transition :: '${url}'`);
    }

    return `${window.location.origin}${url}`;
  },

  loadUserProfile() {

    var self = this;

    this.get('keycloak').loadUserProfile().success(function (profile) {

      Logger.debug(`Loaded profile for ${profile.id}`);
      self.set('profile', profile);
    });
  },

  /**
   * @param url optional redirect url - if not present the
   */
  login(url) {

    var redirectUri = url || this.get('defaultLoginRedirectUri');
    var keycloak = this.get('keycloak');
    var options = {redirectUri};

    Logger.debug('Keycloak session :: login :: ' + JSON.stringify(options));

    return new Promise(function (resolve, reject) {

      keycloak.login(options).success(function () {
        Logger.debug('Keycloak session :: login :: success');
        resolve('login OK');
      }).error(function () {
        Logger.debug('login error - this should never be possible');
        reject(new Error('login failed'));
      });
    });
  },

  /**
   * @param url optional redirect url - if not present the
   */
  logout(url) {

    var redirectUri = url || this.get('defaultLogoutRedirectUri');
    var keycloak = this.get('keycloak');
    var options = {redirectUri};

    Logger.debug('Keycloak session :: logout :: ' + JSON.stringify(options));

    return new Promise(function (resolve, reject) {

      keycloak.logout(options).success(function () {
        Logger.debug('Keycloak session :: logout :: success');
        keycloak.clearToken();
        resolve('logout OK');
      }).error(function () {
        Logger.debug('logout error - this should never be possible');
        keycloak.clearToken();
        reject(new Error('logout failed'));
      });
    });
  }
});
