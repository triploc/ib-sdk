const Events = require("events"),
      constants = require("./constants"),
      symbol = require("./symbol"),
      Subscription = require("./model/subscription"),
      contract = require("./model/contract"),
      orders = require("./model/orders"),
      DisplayGroups = require("./model/displaygroups"),
      Account = require("./model/account"),
      Accounts = require("./model/accounts"),
      Positions = require("./model/positions"),
      Trades = require("./model/trades"),
      System = require("./model/system");

class Session extends Events {
    
    constructor(service, options) {
        super();
        
        Object.defineProperty(this, "domain", { value: this.domain, enumerable: false });
        Object.defineProperty(this, "_events", { value: this._events, enumerable: false });
        Object.defineProperty(this, "_eventsCount", { value: this._eventsCount, enumerable: false });
        Object.defineProperty(this, "_maxListeners", { value: this._maxListeners, enumerable: false });
        
        Object.defineProperty(this, "service", { value: service, enumerable: false });
        
        if (options.orders) {
            this.orders = orders(this.service, options.orders != "all");
        }
        
        this.service.socket.once("managedAccounts", async data => {
            this.managedAccounts = Array.isArray(data) ? data : [ data ];
            this.emit("ready", this);
            
            if (this.clientId === 0) {
                this.service.autoOpenOrders(true);
                if (options.orders != "passive") await this.orders.stream();
            }
            else if (options.orders && options.orders != "passive") await this.orders.stream();
            this.emit("load", this);
        });
        
        this.service.socket.on("connected", () => {
            this.connected = true;
            this.emit("connected");
        }).on("disconnected", () => {
            this.connected = false;
            this.emit("disconnected");
        });
    }
    
    close(exit) {
        if (this.connected) {
            this.connected = false;
            this.service.socket.disconnect();
        }
        
        if (exit) process.exit();
    }
    
    get clientId() {
        return this.service.socket._controller.options.clientId;
    }
    
    system() {
        return new System(this.service);
    }
    
    async account(options) {
        let account = new Account(this.service, options || this.managedAccounts.first());
        return new Promise((resolve, reject) => {
            let errHandler = err => reject(err);
            account.once("error", errHandler).once("load", () => {
                account.removeListener("error", errHandler);
                resolve(account);
            });
        });
    }

    async accounts(options) {
        let accounts = new Accounts(this.service, options);
        return new Promise((resolve, reject) => {
            let errHandler = err => reject(err);
            accounts.once("error", errHandler).once("load", () => {
                accounts.removeListener("error", errHandler);
                resolve(accounts);
            });
        });
    }
    
    async positions() {
        let positions = new Positions(this.service);
        return new Promise((resolve, reject) => {
            let errHandler = err => reject(err);
            positions.once("error", errHandler).once("load", () => {
                positions.removeListener("error", errHandler);
                resolve(positions);
            });
        });
    }

    async trades(options) {
        let trades = new Trades(this.service, options);
        return new Promise((resolve, reject) => {
            let errHandler = err => reject(err);
            trades.once("error", errHandler).once("load", () => {
                trades.removeListener("error", errHandler);
                resolve(trades);
            });
        });
    }
    
    async contract(description) {
        if (description.indexOf(",")) {
            let legs = await Promise.all(description.split(",").map("trim").map(async leg => {
                let ratio = parseInt(leg.to(leg.indexOf(" ")));
                leg = leg.from(leg.indexOf(" ")).trim();

                let summary = await contract.first(symbol.contract(leg));
                if (summary) {
                    summary = summary.summary;
                    return {
                        symbol: summary.symbol,
                        conId: summary.conId,
                        exchange: summary.exchange,
                        ratio: Math.abs(ratio),
                        action: Math.sign(ratio) == -1 ? "SELL" : "BUY",
                        currency: summary.currency
                    };
                }
                else {
                    throw new Error("No contract for " + leg);
                }
            }));

            let name = legs.map("symbol").unique().join(',');
            legs.forEach(leg => delete leg.symbol);

            return new contract.Contract(this.service, { 
                summary: {
                    symbol: name,
                    secType: "BAG",
                    currency: legs.first().currency,
                    exchange: legs.first().exchange,
                    comboLegs: legs
                }
            });
        }
        else {
            let summary = symbol.contract(description);
            return await contract.first(this.service, summary);
        }
    }
    
    async contracts(description) {
        let summary = symbol.contract(description);
        return await contract.all(this.service, summary);
    }
    
    async quote(description) {
        return (await this.contract(description)).quote();
    }
    
    async quotes(description) {
        return (await this.contracts(description)).map(c => c.quote());
    }
    
    async displayGroups() {
        return new Promise((yes, no) => (new DisplayGroups(this.service)).once("load", yes).once("error", no));
    }
    
    async order(description) {
        symbol.order(this.service, description);
    }
    
    async model(options) {
        options = options || Session.defaultScope;
        
        let scope = new Subscription();
        
        if (options.session) {
            scope.session = this;
        }
        
        if (options.system) {
            scope.system = this.system();
            if (options.system == "frozen") {
                scope.system.useFrozenMarketData = true;
            }
        }
        
        if (options.account) {
            scope.account = await this.account(Object.isObject(options.account) ? options.account : null);
        }
        
        if (options.accounts) {
            scope.accounts = await this.accounts();
        }
        
        if (options.positions) {
            scope.positions = await this.positions();
        }
        
        if (options.trades) {
            scope.trades = await this.trades(Object.isObject(options.trades) ? options.trades : null);
        }
        
        if (options.orders) {
            scope.orders = this.orders;
            scope.order = description => this.order(description);
        }
        
        if (options.displayGroups) {
            scope.displayGroups = await this.displayGroups();
        }
        
        if (options.quotes) {
            if (Array.isArray(options.quotes)) {
                await Promise.all(options.quotes.map(async description => {
                    let quote = await this.quote(description.description || description);
                    scope[quote.contract.toString()] = quote;
                    if (description.fields) this.query.addFieldTypes(description.fields);
                    if (options.autoStreamQuotes) {
                        if (options.autoStreamQuotes == "all") return quote.streamAll();
                        else return quote.stream();
                    }
                    else quote.query();
                }));
            }
            else {
                await Promise.all(Object.keys(options.quotes).map(async key => {
                    let description = options.quotes[key];
                    let quote = scope[key] = await this.quote(description.description || description);
                    if (description.fields) this.query.addFieldTypes(description.fields);
                    if (options.autoStreamQuotes) {
                        if (options.autoStreamQuotes == "all") return quote.streamAll();
                        else return quote.stream();
                    }
                    else quote.query();
                }));
            }
        }

        return scope;
    }
    
}

Session.defaultModel = {
    session: true,
    system: true,
    account: true,
    accounts: false,
    positions: false,
    trades: true,
    orders: true,
    displayGroups: false,
    quotes: [ ] || { },
    autoStreamQuotes: false
};

module.exports = Session;