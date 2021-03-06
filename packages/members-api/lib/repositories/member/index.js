const _ = require('lodash');
module.exports = class MemberRepository {
    /**
     * @param {object} deps
     * @param {any} deps.Member
     * @param {any} deps.StripeCustomer
     * @param {any} deps.StripeCustomerSubscription
     * @param {import('../../services/stripe-api')} deps.stripeAPIService
     * @param {import('../../services/stripe-plans')} deps.stripePlansService
     * @param {any} deps.logger
     */
    constructor({
        Member,
        StripeCustomer,
        StripeCustomerSubscription,
        stripeAPIService,
        stripePlansService,
        logger
    }) {
        this._Member = Member;
        this._StripeCustomer = StripeCustomer;
        this._StripeCustomerSubscription = StripeCustomerSubscription;
        this._stripeAPIService = stripeAPIService;
        this._stripePlansService = stripePlansService;
        this._logging = logger;
    }

    async get(data, options) {
        if (data.customer_id) {
            const customer = await this._StripeCustomer.findOne({
                customer_id: data.customer_id
            }, {
                withRelated: ['member']
            });
            if (customer) {
                return customer.related('member');
            }
            return null;
        }
        return this._Member.findOne(data, options);
    }

    async create(data, options) {
        const {labels} = data;

        if (labels) {
            labels.forEach((label, index) => {
                if (typeof label === 'string') {
                    labels[index] = {name: label};
                }
            });
        }

        const memberData = _.pick(data, ['email', 'name', 'note', 'subscribed', 'geolocation', 'created_at']);

        return this._Member.add({
            ...memberData,
            labels
        }, options);
    }

    async update(data, options) {
        const member = await this._Member.edit(_.pick(data, [
            'email',
            'name',
            'note',
            'subscribed',
            'labels',
            'geolocation'
        ]), options);

        if (this._stripeAPIService && member._changed.email) {
            await member.related('stripeCustomers').fetch();
            const customers = member.related('stripeCustomers');
            for (const customer of customers.models) {
                await this._stripeAPIService.updateCustomerEmail(
                    customer.get('customer_id'),
                    member.get('email')
                );
            }
        }

        return member;
    }

    async list(options) {
        return this._Member.findPage(options);
    }

    async destroy(data, options) {
        const member = await this._Member.findOne(data, options);

        if (!member) {
            // throw error?
            return;
        }

        if (this._stripeAPIService && options.cancelStripeSubscriptions) {
            await member.related('stripeSubscriptions');
            const subscriptions = member.related('stripeSubscriptions');
            for (const subscription of subscriptions.models) {
                if (subscription.get('status') !== 'canceled') {
                    const updatedSubscription = await this._stripeAPIService.cancelSubscription(
                        subscription.get('subscription_id')
                    );
                    await this._StripeCustomerSubscription.update({
                        status: updatedSubscription.status
                    });
                }
            }
        }

        return this._Member.destroy({
            id: data.id
        }, options);
    }

    async upsertCustomer(data) {
        return await this._StripeCustomer.upsert({
            customer_id: data.customer_id,
            member_id: data.member_id,
            name: data.name,
            email: data.email
        });
    }

    async linkStripeCustomer(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot link Stripe Customer with no Stripe Connection');
        }
        const customer = await this._stripeAPIService.getCustomer(data.customer_id);

        if (!customer) {
            return;
        }

        // Add instead of upsert ensures that we do not link existing customer
        await this._StripeCustomer.add({
            customer_id: data.customer_id,
            member_id: data.member_id,
            name: customer.name,
            email: customer.email
        }, options);

        for (const subscription of customer.subscriptions.data) {
            await this.linkSubscription({
                id: data.member_id,
                subscription
            }, options);
        }
    }

    async linkSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot link Stripe Subscription with no Stripe Connection');
        }
        const member = await this._Member.findOne({
            id: data.id
        }, options);

        const customer = await member.related('stripeCustomers').query({
            where: {
                customer_id: data.subscription.customer
            }
        }).fetchOne(options);

        if (!customer) {
            // Maybe just link the customer?
            throw new Error('Subscription is not associated with a customer for the member');
        }

        const subscription = await this._stripeAPIService.getSubscription(data.subscription.id);
        let paymentMethodId;
        if (!subscription.default_payment_method) {
            paymentMethodId = null;
        } else if (typeof subscription.default_payment_method === 'string') {
            paymentMethodId = subscription.default_payment_method;
        } else {
            paymentMethodId = subscription.default_payment_method.id;
        }
        const paymentMethod = paymentMethodId ? await this._stripeAPIService.getCardPaymentMethod(paymentMethodId) : null;
        await this._StripeCustomerSubscription.upsert({
            customer_id: subscription.customer,
            subscription_id: subscription.id,
            status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            cancellation_reason: subscription.metadata && subscription.metadata.cancellation_reason || null,
            current_period_end: new Date(subscription.current_period_end * 1000),
            start_date: new Date(subscription.start_date * 1000),
            default_payment_card_last4: paymentMethod && paymentMethod.card && paymentMethod.card.last4 || null,

            plan_id: subscription.plan.id,
            // NOTE: Defaulting to interval as migration to nullable field
            // turned out to be much bigger problem.
            // Ideally, would need nickname field to be nullable on the DB level
            // condition can be simplified once this is done
            plan_nickname: subscription.plan.nickname || subscription.plan.interval,
            plan_interval: subscription.plan.interval,
            plan_amount: subscription.plan.amount,
            plan_currency: subscription.plan.currency
        }, {
            ...options,
            subscription_id: subscription.id
        });
    }

    async updateSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot update Stripe Subscription with no Stripe Connection');
        }
        const member = await this._Member.findOne({
            id: data.id
        });

        const subscription = await member.related('stripeSubscriptions').query({
            where: {
                subscription_id: data.subscription.subscription_id
            }
        }).fetchOne(options);

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        if (data.subscription.cancel_at_period_end === undefined) {
            throw new Error('Incorrect usage');
        }

        if (data.subscription.cancel_at_period_end) {
            await this._stripeAPIService.cancelSubscriptionAtPeriodEnd(data.subscription.subscription_id);
        } else {
            await this._stripeAPIService.continueSubscriptionAtPeriodEnd(data.subscription.subscription_id);
        }

        await this._StripeCustomerSubscription.edit({
            subscription_id: data.subscription.subscription_id,
            cancel_at_period_end: data.subscription.cancel_at_period_end
        }, {
            id: subscription.id
        });
    }

    async setComplimentarySubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot update Stripe Subscription with no Stripe Connection');
        }
        const member = await this._Member.findOne({
            id: data.id
        }, options);

        const subscriptions = await member.related('stripeSubscriptions').fetch(options);

        const activeSubscriptions = subscriptions.models.filter((subscription) => {
            return ['active', 'trialing', 'unpaid', 'past_due'].includes(subscription.get('status'));
        });

        // NOTE: Because we allow for multiple Complimentary plans, need to take into account currently availalbe
        //       plan currencies so that we don't end up giving a member complimentary subscription in wrong currency.
        //       Giving member a subscription in different currency would prevent them from resubscribing with a regular
        //       plan if Complimentary is cancelled (ref. https://stripe.com/docs/billing/customer#currency)
        let complimentaryCurrency = this._stripePlansService.getPlans().find(plan => plan.interval === 'month').currency.toLowerCase();

        if (activeSubscriptions.length) {
            complimentaryCurrency = activeSubscriptions[0].get('plan_currency').toLowerCase();
        }

        const complimentaryPlan = this._stripePlansService.getComplimentaryPlan(complimentaryCurrency);

        if (!complimentaryPlan) {
            throw new Error('Could not find Complimentary plan');
        }

        let stripeCustomer;

        await member.related('stripeCustomers').fetch(options);

        for (const customer of member.related('stripeCustomers').models) {
            try {
                const fetchedCustomer = await this._stripeAPIService.getCustomer(customer.get('customer_id'));
                if (!fetchedCustomer.deleted) {
                    stripeCustomer = fetchedCustomer;
                    break;
                }
            } catch (err) {
                console.log('Ignoring error for fetching customer for checkout');
            }
        }

        if (!stripeCustomer) {
            stripeCustomer = await this._stripeAPIService.createCustomer({
                email: member.get('email')
            });

            await this._StripeCustomer.upsert({
                customer_id: stripeCustomer.id,
                member_id: data.id,
                email: stripeCustomer.email,
                name: stripeCustomer.name
            }, options);
        }

        if (!activeSubscriptions.length) {
            const subscription = await this._stripeAPIService.createSubscription(stripeCustomer.id, complimentaryPlan.id);

            await this.linkSubscription({
                id: member.id,
                subscription
            }, options);
        } else {
            // NOTE: we should only ever have 1 active subscription, but just in case there is more update is done on all of them
            for (const subscription of activeSubscriptions) {
                const updatedSubscription = await this._stripeAPIService.changeSubscriptionPlan(
                    subscription.get('subscription_id'),
                    complimentaryPlan.id
                );

                await this.linkSubscription({
                    id: member.id,
                    subscription: updatedSubscription
                }, options);
            }
        }
    }

    async cancelComplimentarySubscription(data) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot cancel Complimentary Subscription with no Stripe Connection');
        }

        const member = await this._Member.findOne({
            id: data.id
        });

        const subscriptions = await member.related('stripeSubscriptions').fetch();

        for (const subscription of subscriptions.models) {
            if (subscription.get('status') !== 'canceled') {
                try {
                    const updatedSubscription = await this._stripeAPIService.cancelSubscription(
                        subscription.get('subscription_id')
                    );
                    // Only needs to update `status`
                    await this.linkSubscription({
                        id: data.id,
                        subscription: updatedSubscription
                    });
                } catch (err) {
                    this._logging.error(`There was an error cancelling subscription ${subscription.get('subscription_id')}`);
                    this._logging.error(err);
                }
            }
        }
        return true;
    }
};
