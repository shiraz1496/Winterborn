
Seasonal Retail Inventory & Smart Restocking System

1. Project Overview
   The objective of this project is to replace a largely manual and fragmented inventory process with a centralized system that can track warehouse inventory, inventory distributed to seasonal market locations, sales through Square POS, and restocking requirements.

The business sells primarily handmade woolen products through temporary seasonal booths and markets. Products arrive without manufacturer barcodes, and shipments can contain variations in colors, shades, sizes, and product types. This makes traditional barcode-based retail inventory tracking impractical.

The existing operation relies mainly on:

Sortly for warehouse inventory management and historical inventory records.

Square POS for sales at market booths.

Manual communication between market managers and warehouse staff for restocking.

Manual decisions about how much inventory should be sent to each location.

The new platform will ultimately become the operational source of truth for inventory movement, location-level inventory, sales-based depletion, restocking decisions, and shipment planning.

2. Business Background
   The business operates primarily through temporary seasonal retail locations rather than permanent stores.

The primary sales season occurs around November and December, although some markets begin earlier or remain operational into January.

Different markets may operate for different durations, for example:

6 weeks

7 weeks

8 weeks

Extended periods into January

During the peak Christmas period, sales volume increases significantly.

The temporary nature of these locations also means staff can be hired quickly and may work only for a short period. Therefore, the system cannot depend on highly trained retail employees performing complicated inventory operations.

The workflow needs to remain extremely simple for warehouse workers, market managers, and sales operators.

3. Existing Inventory Environment
   3.1 Product Characteristics
   A major difficulty is that many products do not arrive with standard barcodes.

Products are handmade and may arrive in mixed packages containing different:

Colors

Color shades

Sizes

Product types

Designs

For example, a shipment could contain scarves with several different shades of blue rather than one standardized color.

Similarly, products such as handmade woolen toys may contain variations such as:

Lion

Bear

Elephant

along with different sizes or colors.

Because the supplier does not provide standardized retail identifiers, the company must establish its own internal product structure.

4. Current Systems
   4.1 Sortly
   Sortly currently contains the most reliable warehouse inventory information.

Historically, warehouse staff manually:

Opened incoming packages.

Counted the items.

Took photographs.

Assigned categories.

Recorded quantities.

Stored the information in Sortly.

Sortly therefore contains important historical information about:

Products

Categories

Inventory quantities

Inventory movement

Previous shipments

Locations

Product images

Historical inventory activity

This historical data is valuable because it can help determine how much inventory was previously sent to specific markets.

The new platform will initially import existing Sortly information and eventually replace Sortly as the primary operational inventory system.

4.2 Square POS
Square is used at the individual seasonal retail booths to process sales.

Square provides the most important indication of actual inventory consumption at the selling location.

If 100 units of a product are allocated to a location and Square records 20 units sold, the system can estimate:

Remaining Inventory = 100 - 20 = 80 units

Square sales therefore become the primary mechanism for calculating inventory depletion at the retail location.

Square will be integrated with the new platform so sales information can update inventory calculations in near real time.

5. Main Problems Being Solved
   5.1 No Reliable Location-Level Inventory
   The business currently understands what inventory exists in the main warehouse reasonably well.

The problem begins once products leave the warehouse.

After inventory is distributed to a market, it becomes difficult to determine:

What is currently available at each location.

Which products are selling.

Which product colors are selling.

Which products are running low.

Which market needs restocking.

How urgently inventory needs to be shipped.

The new system must maintain inventory independently for every location.

5.2 Poor Color Visibility
Square currently does not provide sufficiently useful color information for many products.

For example, management may know that scarves were sold but not know whether customers purchased:

Blue

Red

Green

Pink

Orange

This makes replenishment inaccurate.

The new catalog structure will therefore introduce standardized primary color groups.

Instead of requiring employees to distinguish between:

Sky Blue

Navy Blue

Royal Blue

Light Blue

the Square interface can simply ask them to select:

Blue

This intentionally sacrifices shade-level accuracy at the POS in favor of reliable operational data.

Detailed shade information may still exist at the warehouse/catalog level where appropriate.

6. Inventory Architecture
   The inventory model contains three important physical levels.

Level 1 — Main Warehouse
The primary warehouse is located in Chicago.

Inventory received from vendors initially enters this warehouse.

This represents the company's central inventory pool.

Level 2 — Market / Location Warehouse
Some markets have a local storage or warehouse facility near the selling location.

Large quantities of inventory can be transferred from Chicago to this facility.

Example:

Chicago Main Warehouse → Denver Market Warehouse

This inventory must remain separately tracked.

If Denver contains 5,000 units, those 5,000 units represent Denver inventory rather than general company inventory.

Level 3 — Booth / Store
The final level is the temporary retail booth where customers actually purchase products.

Inventory moves approximately as:

Vendor → Chicago Warehouse → Market Warehouse → Booth → Customer

Not every market necessarily requires a separate warehouse, but the system should support this structure.

7. Location-Level Inventory
   Inventory must be calculated independently for each location.

For example:

Chicago Warehouse:

10,000 units

Denver Location:

5,000 units

The system should not simply report:

15,000 units available.

It needs to understand where those units physically exist.

This allows the platform to answer questions such as:

How much inventory exists in Chicago?

How much exists in Denver?

How much has Denver sold?

How much inventory remains available to the Denver market?

Which markets are approaching stock shortages?

Location-level inventory is essential for intelligent restocking.

8. Product Catalog Model
   The new system needs a standardized product structure.

Depending on the product category, attributes may include:

Product type

Category

Primary color

Detailed shade

Size

Material

Design/type

Product image

Warehouse SKU

Square/POS SKU

Quantity

Location

Inventory status

Different categories may use different attributes.

Example — Scarf
Product: Scarf

Color Group: Blue

Shade: Navy Blue

Size: Standard

Example — Wool Toy
Product: Wool Toy

Type: Elephant

Color: Grey

Size: Small

Attributes should therefore be flexible rather than forcing every product into exactly the same structure.

9. Simplified POS Catalog
   Warehouse inventory can contain detailed product information.

However, the Square catalog used by temporary employees needs to remain extremely simple.

Employees should not have to determine subtle product characteristics.

For example:

Instead of:

Scarf → Navy Blue → Dark Navy → Style 03

the salesperson may simply select:

Scarf → Blue

The purpose is to maximize the probability that sales data is consistently recorded correctly.

Reliable broad categorization is more valuable than inaccurate detailed categorization.

10. Warehouse Receiving Workflow
    When products arrive at the Chicago warehouse, warehouse staff will use the new system.

The intended workflow is:

Open the application.

Select Receive Inventory.

Take a photograph of the product if necessary.

Select an existing product/category.

Select applicable attributes.

Enter quantity.

Confirm inventory receipt.

If the product does not exist, an authorized user can create the product/category.

The interface should be optimized for warehouse workers rather than technical administrators.

11. Camera-Assisted Inventory Entry
    The application should support device camera access.

Warehouse staff can photograph incoming products while processing inventory.

Product images can help:

Identify existing products.

Distinguish similar products.

Verify categories.

Reduce duplicate catalog entries.

Simplify warehouse operations.

AI-assisted image recognition may later help suggest likely product categories.

However, users should always be able to manually select or correct the product.

12. Progressive Web Application
    The initial system should be implemented as a Progressive Web Application (PWA) rather than requiring dedicated iOS and Android applications.

The PWA should work effectively on:

Desktop computers

Tablets

Mobile phones

Mobile functionality is particularly important for warehouse operations.

Required mobile capabilities include:

Camera access

Inventory entry

Product selection

Shipment processing

Location selection

Restock requests

A native mobile application can be considered later if operational limitations appear.

13. Shipment Creation
    Warehouse employees need to record what inventory is being shipped and where it is going.

A shipment workflow should allow the operator to:

Select destination location.

Create a shipment.

Select products.

Enter quantities.

Pack products into shipment/boxes.

Confirm shipment.

Once inventory leaves the Chicago warehouse, the corresponding quantities should be deducted from Chicago inventory and transferred to the destination inventory state.

The platform must therefore maintain a reliable inventory movement ledger rather than simply maintaining one global stock number.

14. Box Tracking and QR Codes
    An initial idea was to assign QR codes to shipment boxes.

A market manager could scan the QR code when receiving or opening a box.

This would provide additional confirmation that inventory physically reached the destination.

However, requiring managers to scan every box could introduce operational complexity.

Therefore:

QR-based box tracking is optional functionality.

The first version should determine whether sufficient inventory accuracy can be achieved using:

Shipment records

Location inventory

Square sales deductions

If these provide reliable results, mandatory QR scanning is unnecessary.

QR functionality can later be introduced if discrepancies make stronger physical tracking necessary.

15. Square Sales Synchronization
    Square transactions should continuously synchronize with the platform.

When a transaction occurs:

Square records the sale.

The integration retrieves or receives the transaction.

The product/SKU is identified.

The selling location is identified.

The corresponding location inventory is reduced.

Restocking calculations are updated.

This creates a continually updated estimate of remaining stock.

16. Automatic Low-Stock Detection
    One of the primary goals of the platform is to eliminate reliance on store managers manually noticing shortages.

The system should continuously evaluate inventory levels.

Locations should automatically be flagged when products are:

Running low

Expected to run low soon

Critically low

Out of stock

Example:

Denver has 30 blue scarves remaining and is selling approximately 15 per day.

The platform can estimate that the location has approximately two days of stock remaining.

Instead of waiting until inventory reaches zero, the system should create a replenishment warning beforehand.

17. Restocking Dashboard
    The platform should provide a centralized view of locations requiring attention.

Example:

Location	Product	Remaining	Status
Denver	Blue Scarf	30	Low
Atlanta	Socks	10	Critical
Chicago Market	Red Scarf	0	Out of Stock
This allows warehouse management to prioritize shipments without waiting for phone calls from individual managers.

18. Manual Restock Requests
    Market managers and authorized employees should still be able to request inventory manually.

For example:

Denver manager requests 500 pairs of socks.

However, a request should not automatically result in 500 units being shipped.

The system should evaluate the request against available information.

Factors can include:

Remaining inventory at the requesting location

Sales velocity

Historical sales

Available warehouse inventory

Requirements of other markets

Remaining market duration

Previous location performance

The system may therefore respond:

Requested: 500
Recommended: 400

The warehouse/admin team can then approve an appropriate quantity.

19. Preventing Inventory Overallocation
    A major existing problem occurs when one market requests more inventory than should reasonably be allocated.

Example:

Available warehouse inventory:

500 socks

Location A requests:

500

Location B requires:

100

If all 500 units are shipped to Location A, Location B cannot be replenished.

The new system should detect this situation before shipment.

It should evaluate inventory requirements across all active locations and recommend balanced allocation.

For example:

Location A requested 500 units.
100 units should remain reserved for Location B.
Maximum recommended shipment: 400 units.

20. Smart Shipments Based on Historical Data
    A major feature of the platform will be Smart Shipments Based on Historical Data.

Instead of relying entirely on manager requests, the platform will analyze historical and current performance to recommend replenishment.

For example:

If a location requests 1,500 units but:

historically sold approximately 1,000–1,200 units,

currently has inventory remaining,

and other locations also require inventory,

the platform may recommend sending approximately 1,200 units instead.

The recommendation can include an additional safety buffer where appropriate.

The final decision remains controlled by authorized users.

21. Historical Data Migration
    Historical information from Sortly should be imported into the new platform.

Relevant historical information may include:

Inventory records

Product categories

Product photographs

Previous quantities

Historical transfers

Location information

Shipment history where available

Inventory adjustments

Historical Square sales information should also be incorporated where useful.

This dataset becomes the foundation for future demand analysis.

22. Smart Shipment Inputs
    Smart shipment recommendations can use factors such as:

Historical Factors
Previous sales at the location

Previous quantities shipped

Previous restocking frequency

Previous stock shortages

Product-specific demand

Current Factors
Current inventory

Current sales velocity

Remaining market duration

Warehouse availability

Other locations' requirements

New Location Factors
When historical sales do not exist for a new market, additional information can potentially be used:

Geographic location

Population

Weather/climate

Consumer spending capacity

Christmas/holiday period

Market duration

Seasonal peaks

Nearby comparable locations

This information can be combined with performance from similar existing markets to establish an initial demand estimate.

23. Smart Shipment Objective
    The goal of smart shipment logic is not simply to predict sales.

Its operational objective is to balance two risks:

Understocking
Too little inventory results in:

Empty booths

Lost sales

Emergency shipments

Additional shipping expense

Overstocking
Too much inventory results in:

Inventory unnecessarily locked at one location

Other markets being unable to restock

Additional redistribution requirements

Unsold inventory

The system should therefore recommend the smallest practical shipment that provides sufficient inventory until the next reasonable replenishment opportunity.

24. Shipment Consolidation
    The platform should also reduce unnecessary shipping costs.

For example, if one product will become critically low tomorrow and another product is expected to become critically low two days later, sending two separate shipments may be inefficient.

The system can identify this situation and recommend:

Include the second product in today's shipment.

This allows multiple upcoming replenishment needs to be consolidated into a smart shipment.

25. Inventory Status / Priority Zones
    Products and locations can be categorized into operational priority levels.

For example:

Healthy
Sufficient inventory exists.

Low
Inventory is approaching the replenishment threshold.

Critical / Red Zone
Inventory is likely to run out before normal replenishment can occur.

Out of Stock
No inventory remains.

These statuses should appear prominently on the operational dashboard.

26. Roles and Permissions
    Strong role-based access control is required.

One of the existing operational problems was excessive Square permissions being provided to temporary staff.

The new environment should follow the principle of minimum required access.

Possible roles include:

Administrator
Can:

Manage users

Manage products

Create/edit categories

Configure locations

Manage integrations

Approve inventory decisions

Access reporting and system configuration

Warehouse Manager
Can:

Receive inventory

Create shipments

Adjust authorized inventory

Review replenishment recommendations

Approve or manage warehouse operations

Warehouse Operator
Can:

Receive existing products

Enter quantities

Take product photographs

Pack shipments

Process inventory movements

Cannot:

Create products

Modify the master catalog

Modify integrations

Change system configuration

Market Manager
Can:

View location inventory

View low-stock products

Submit restock requests

View shipment status

Perform approved market-level actions

Sales Operator
Uses the required Square selling functions.

Should not be able to:

Add products

Modify the catalog

Change pricing without authorization

Modify administrative Square settings

Square permissions should also be configured according to these responsibilities.

27. Product Creation Controls
    Product creation should specifically be protected.

Temporary operators must not be able to create arbitrary products.

Only authorized roles should be capable of:

Adding products

Creating categories

Modifying SKUs

Changing important attributes

Modifying mappings between the internal platform and Square

This reduces catalog corruption and prevents unauthorized items from being introduced into the company's selling environment.

28. Restock Request Workflow
    The system should include a lightweight request workflow.

This does not need to become a full chat or collaboration platform.

A market employee can submit:

Location

Product

Requested quantity

Optional note

The request appears in the administrative/warehouse interface.

The platform can then display:

Requested quantity

Current location inventory

Current warehouse inventory

Historical consumption

System-recommended quantity

Priority

Authorized warehouse staff can then approve, modify, or reject the requested quantity.

29. Source of Truth Transition
    Initially, information will be migrated from Sortly.

During migration:

Sortly → New Inventory Platform

Existing data should be cleaned, normalized, and imported into structured relational data.

Once the migration and operational validation are complete, the new platform should become the primary inventory source of truth.

Future processes such as:

Receiving

Categorization

Inventory movement

Shipment creation

Location assignment

Restocking

should then happen through the new platform.

30. Primary Functional Modules
    The complete platform can logically be divided into the following modules:
31. Product Catalog
    Product types, categories, attributes, colors, sizes, images, SKUs and Square mappings.
32. Warehouse Inventory
    Receiving and management of central warehouse inventory.
33. Location Inventory
    Inventory available at individual market warehouses and booths.
34. Inventory Movement
    Transfers between warehouses, markets and booths.
35. Shipment Management
    Shipment creation, packing, destination assignment and status.
36. Square Integration
    Sales synchronization and location-specific inventory consumption.
37. Restocking Engine
    Low-stock detection, thresholds and replenishment alerts.
38. Smart Shipments
    Historical and current demand-based shipment recommendations.
39. Restock Requests
    Manual requests submitted by market managers/employees.
40. User & Role Management
    Permissions for administrators, managers, warehouse operators and sales operators.
41. Reporting & Analytics
    Location performance, product performance, sales velocity, inventory consumption and shipment effectiveness.
42. Historical Data
    Imported Sortly and Square information supporting reporting and smart shipment recommendations.
43. Key Operational Principle
    The most important design principle is:

Track inventory by location, not simply as company-wide inventory.

Knowing that the company has 10,000 scarves is insufficient.

The system must know:

where those scarves currently are,

what is selling at each location,

how quickly each location is consuming them,

how much inventory remains centrally available,

and which location should receive the next shipment.

32. End-to-End Workflow
    The expected operating flow is:

Vendor
↓
Products arrive at Chicago warehouse
↓
Warehouse employee records products in the new platform
↓
Inventory becomes available in Chicago stock
↓
Shipment is prepared for a market
↓
Products are allocated/transferred to that location
↓
Location inventory increases
↓
Products reach the booth
↓
Employee sells product through Square
↓
Square transaction synchronizes with platform
↓
Location inventory decreases
↓
System evaluates remaining quantity and sales velocity
↓
Low-stock threshold is reached
↓
Restocking recommendation is generated
↓
System checks other locations and warehouse availability
↓
Smart shipment quantity is recommended
↓
Authorized employee approves shipment
↓
Warehouse creates replenishment shipment
↓
Location inventory is replenished

33. Expected Business Outcome
    The system is intended to move the business from a reactive inventory process:

“A manager calls because socks have already run out.”

to a proactive process:

“The system predicts that Denver will run low on socks within two days and recommends adding 120 units to tomorrow's shipment.”

The broader objective is to achieve:

Fewer stockouts

Better product availability

Better allocation between markets

Fewer unnecessary emergency shipments

More reliable product/color sales data

Better use of historical data

Reduced reliance on individual employee knowledge

Centralized inventory visibility

More controlled Square access

Better planning for future seasonal markets
